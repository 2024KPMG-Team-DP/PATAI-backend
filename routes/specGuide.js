// imports
const express = require("express");
const dotenv = require("dotenv");
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const specGuidePrompt = require("../prompts/specGuidePrompt");

// config
dotenv.config();
const router = express.Router();

// azure
const client = new OpenAIClient(
  process.env.AZURE_ENDPOINT,
  new AzureKeyCredential(process.env.AZURE_KEY)
);

// 답변 생성
const generateAnswer = async (userPrompt) => {
  try {
    // 대화 생성
    const dialogue = [
      {
        role: "system",
        content: specGuidePrompt,
      },
      { role: "user", content: userPrompt },
    ];

    // 답변
    const specResponse = await client.getChatCompletions(
      process.env.AZURE_GPT,
      dialogue
    );
    return specResponse.choices[0].message;
  } catch (err) {
    console.error(err);
  }
};

// routers
router.post("/", async (req, res) => {
  const { body } = req;
  const userPrompt = JSON.stringify(body);
  //   console.log(body);
  console.log(userPrompt);
  const result = await generateAnswer(userPrompt);
  res.json(result.content);
});

module.exports = router;
