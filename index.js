require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const translate = require('@vitalets/google-translate-api');
const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const csv = require('csvtojson');
const mongoose = require('mongoose');
const cron = require('node-cron');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public')); // serve frontend

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ---------------- Twilio Setup ----------------
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const WHATSAPP_NUMBER = "whatsapp:+14155238886"; // Twilio sandbox number

// ---------------- MongoDB Setup ----------------
mongoose.connect('mongodb://127.0.0.1:27017/healthBotDB', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => console.error("❌ MongoDB error:", err));

const userSchema = new mongoose.Schema({
  name: String,
  phone: String, // user WhatsApp number
  subscription: { type: String, enum: ["daily", "weekly"], default: "daily" },
  state: String
});
const User = mongoose.model("User", userSchema);

// ---------------- Helper Functions ----------------
function splitMessage(text, limit = 1500) {
  const parts = [];
  for (let i = 0; i < text.length; i += limit) {
    parts.push(text.slice(i, i + limit));
  }
  return parts;
}

async function sendWhatsAppMessage(to, body) {
  try {
    await client.messages.create({
      from: WHATSAPP_NUMBER,
      to: `whatsapp:${to}`,
      body: body
    });
    console.log(`📤 Sent WhatsApp message to ${to}`);
  } catch (err) {
    console.error("❌ Error sending WhatsApp message:", err.message);
  }
}

// ---------------- State + Disease Extraction ----------------
const statesIndia = [
  "andhra pradesh","arunachal pradesh","assam","bihar","chhattisgarh",
  "goa","gujarat","haryana","himachal pradesh","jammu and kashmir",
  "jharkhand","karnataka","kerala","madhya pradesh","maharashtra",
  "manipur","meghalaya","mizoram","nagaland","odisha","punjab",
  "rajasthan","sikkim","tamil nadu","telangana","tripura",
  "uttar pradesh","uttarakhand","west bengal","andaman and nicobar islands",
  "chandigarh","dadra and nagar haveli","daman and diu","delhi",
  "lakshadweep","puducherry"
];

const diseaseKeywords = ["covid","covid-19","dengue","malaria","fever","headache","flu","cholera","jaundice"];

function extractState(query) {
  const q = query.toLowerCase();
  return statesIndia.find(state => q.includes(state)) || null;
}

function extractDisease(query) {
  const q = query.toLowerCase();
  return diseaseKeywords.find(d => q.includes(d)) || null;
}

// ---------------- Govt Data Fetch ----------------
async function fetchGovtData() {
  const dataMap = {}; // {state: {disease: info}}
  try {
    // COVID-19 (MoHFW)
    const covidRes = await axios.get("https://www.mohfw.gov.in/data/datanew.json");
    if (Array.isArray(covidRes.data)) {
      covidRes.data.forEach(row => {
        const state = row.state_name.toLowerCase();
        if (!dataMap[state]) dataMap[state] = {};
        dataMap[state]["covid"] = `🦠 COVID-19 update for ${row.state_name}:\n- Active: ${row.active}\n- Cured: ${row.cured}\n- Deaths: ${row.death}`;
      });
    }

    // NVBDCP (Dengue/Malaria) - example CSV feed
    const nvbdcpCSVUrl = "https://nvbdcp.gov.in/weekly_disease_data.csv"; // replace with actual
    try {
      const nvbdcpData = await csv().fromStream(await axios({url:nvbdcpCSVUrl,responseType:'stream'}).then(r=>r.data));
      nvbdcpData.forEach(row => {
        const state = row.State.toLowerCase();
        if (!dataMap[state]) dataMap[state] = {};
        if (row.Disease.toLowerCase().includes("dengue")) dataMap[state]["dengue"] = `🦟 Dengue cases in ${row.State}: ${row.Cases}`;
        if (row.Disease.toLowerCase().includes("malaria")) dataMap[state]["malaria"] = `🦟 Malaria cases in ${row.State}: ${row.Cases}`;
      });
    } catch(err) { console.error("⚠️ NVBDCP error:", err.message); }
  } catch(err) { console.error("⚠️ Govt fetch error:", err.message); }
  return dataMap;
}

// ---------------- Govt Fallback ----------------
async function govtFallback(query,dataMap) {
  const state = extractState(query);
  const disease = extractDisease(query);
  if (!state || !disease) return null;
  const stateData = dataMap[state.toLowerCase()];
  if (!stateData) return null;
  return stateData[disease.toLowerCase()] || null;
}

// ---------------- Translation ----------------
async function safeTranslate(text,targetLang='en') {
  if(!text || text.trim()==='') return text;
  try {
    const res = await translate(text,{to:targetLang});
    return res.text;
  } catch(err){console.error("⚠️ Translation error:",err);return text;}
}

// ---------------- Gemini AI ----------------
async function getAIResponse(query) {
  const prompt = `Answer concisely in 4-5 lines: ${query}\nInclude preventive tips and advise consulting a doctor.`;
  try {
    const response = await ai.models.generateContent({model:'gemini-2.5-flash',contents: prompt});
    return response.text;
  } catch(err){console.error("❌ Gemini AI error:",err);return "⚠️ Unable to answer. Please consult a doctor.";}
}

// ---------------- Emergency Info ----------------
const emergencyNumbers = {
  "all": "☎️ National Health Helpline: 1800-180-1234",
  "telangana":"☎️ Telangana Health Helpline: 104",
  "maharashtra":"☎️ Maharashtra Health Helpline: 102",
};

// ---------------- Symptom Checker ----------------
async function symptomChecker(symptoms) {
  const prompt = `User reports symptoms: ${symptoms}. Based on Indian context, suggest possible diseases, severity, preventive measures, and whether immediate doctor consultation is needed.`;
  return await getAIResponse(prompt);
}
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});


// ---------------- Frontend Registration API ----------------
app.post('/api/register', async (req, res) => {
  const { name, phone, state, subscription } = req.body;
  if (!name || !phone) return res.status(400).json({ error: "Name and phone are required" });

  try {
    const existingUser = await User.findOne({ phone });
    if (existingUser) return res.status(400).json({ error: "User already exists" });

    const newUser = new User({ name, phone, state, subscription: subscription || "daily" });
    await newUser.save();

    // Send welcome WhatsApp message
    await sendWhatsAppMessage(phone, `👋 Hi ${name}! You are subscribed for ${newUser.subscription} health alerts.`);

    res.json({ message: "Registration successful!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// Get user stats
app.get('/api/stats', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const dailyUsers = await User.countDocuments({ subscription: "daily" });
    const weeklyUsers = await User.countDocuments({ subscription: "weekly" });

    res.json({ totalUsers, dailyUsers, weeklyUsers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------------- WhatsApp Webhook ----------------
app.post('/whatsapp',async(req,res)=>{
  let incomingMsg = req.body.Body;
  console.log("📩 User message:",incomingMsg);

  let detectedLang = 'en';
  try {
    const detection = await translate(incomingMsg,{to:'en'});
    incomingMsg = detection.text;
    detectedLang = detection.from.language.iso;
  } catch(err){console.error("⚠️ Translation error:",err);}

  const dataMap = await fetchGovtData();
  let reply = null;

  // Emergency
  const emergencyQuery = incomingMsg.toLowerCase();
  if(emergencyQuery.includes("emergency") || emergencyQuery.includes("help") || emergencyQuery.includes("helpline")) {
    const state = extractState(incomingMsg);
    reply = (state && emergencyNumbers[state.toLowerCase()]) || emergencyNumbers["all"];
  }
  // Symptom checker
  else if(emergencyQuery.includes("symptoms") || emergencyQuery.includes("i have")) {
    reply = await symptomChecker(incomingMsg);
  }
  // Govt data
  else {
    reply = await govtFallback(incomingMsg,dataMap);
  }
  // Gemini AI fallback
  if(!reply) reply = await getAIResponse(incomingMsg);

  // Translate back
  if(detectedLang !== 'en') {
    try {
      const backTranslation = await translate(reply,{to:detectedLang});
      reply = backTranslation.text;
    } catch(err){console.error("⚠️ Back translation error:",err);}
  }

  const twiml = new MessagingResponse();
  splitMessage(reply).forEach(part=>twiml.message(part));
  res.type('text/xml').send(twiml.toString());
});

// ---------------- Daily Alerts ----------------
cron.schedule('0 9 * * *', async () => {  // every day at 9 AM
  console.log("📢 Sending daily health alerts...");
  const users = await User.find({ subscription: "daily" });
  const dataMap = await fetchGovtData();

  for (const user of users) {
    const state = user.state ? user.state.toLowerCase() : null;
    let alertMsg = "📢 Daily Health Alert:\nStay safe and take precautions.";
    if (state && dataMap[state]) {
      const diseases = Object.values(dataMap[state]);
      if (diseases.length > 0) {
        alertMsg = "📢 Daily Health Alert for " + user.state + ":\n" + diseases.join("\n");
      }
    }

    await sendWhatsAppMessage(user.phone, alertMsg);
  }
});

// ---------------- Start Server ----------------
app.listen(3000,()=>console.log("⚡ Advanced WhatsApp Health Bot running on port 3000"));
