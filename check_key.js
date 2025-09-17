require('dotenv').config();
console.log("OpenAI Key:", process.env.OPENAI_API_KEY ? "FOUND" : "MISSING");
