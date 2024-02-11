// imports
const express = require("express");
const dotenv = require("dotenv");
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const { techPrompt, lawPrompt } = require("../prompts/techReviewPrompt");

// config
dotenv.config();
const router = express.Router();

// azure
const client = new OpenAIClient(process.env.AZURE_ENDPOINT, new AzureKeyCredential(process.env.AZURE_KEY));

// pinecone
const pc = new Pinecone({ apiKey: process.env.PINECONE_KEY });
const index = pc.index(process.env.PINECONE_INDEX);


// sentence -> embedding
const getEmbedding = async (t) => {
  try {
    const embedding = await client.getEmbeddings(process.env.AZURE_EMBEDDING, [t]);
    return embedding.data[0].embedding;
  } catch (err) { console.error(err); }
}

// 선행기술 DB 검토
const queryToTechIndex = async (userPrompt) => {
  try {
    const embedding = await getEmbedding(userPrompt);
    const result = await index.namespace("socks").query({
      topK: 5,
      vector: embedding,
      includeMetadata: true
    });
    console.log(JSON.stringify(result.matches[0].metadata));
    return result;
  } catch (err) { console.error(err); }
}

// 특허법 DB 검토
const queryToLawIndex = async (techResponse) => {
  const embedding = await getEmbedding(techResponse);
  const result = await index.namespace("patent_law").query({
    topK: 3,
    vector: embedding,
    includeMetadata: true
  });
  console.log(result.matches[0].metadata);
  return result;
}

// 답변 생성
const generateAnswer = async (userPrompt) => {
  try {
    // 선행기술 DB 탐색 결과
    const techReviewResult = await queryToTechIndex(userPrompt);

    // 대화 생성
    const dialogue = [
      {
        role: "system",
        content: techPrompt
        + JSON.stringify(techReviewResult.matches[0].metadata)
        + JSON.stringify(techReviewResult.matches[1].metadata)
        + JSON.stringify(techReviewResult.matches[2].metadata)
        + JSON.stringify(techReviewResult.matches[3].metadata)
        + JSON.stringify(techReviewResult.matches[4].metadata)
      },
      { role: "user", content: userPrompt }
    ];

    // 선행기술 검토 답변
    const techResponse = await client.getChatCompletions(process.env.AZURE_GPT, dialogue);

    // 특허법 DB 탐색 결과
    const lawReviewResult = await queryToLawIndex(techResponse.choices[0].message.content);

    // 대화 추가
    dialogue.push(techResponse.choices[0].message);
    dialogue.push({
      role: "system",
      content: lawPrompt
      + JSON.stringify(lawReviewResult.matches[0].metadata)
      + JSON.stringify(lawReviewResult.matches[1].metadata)
      + JSON.stringify(lawReviewResult.matches[2].metadata)
    });

    // 특허법 검토 답변
    const lawResponse = await client.getChatCompletions(process.env.AZURE_GPT, dialogue);
    return lawResponse.choices[0].message;
  } catch (err) { console.error(err); }
}


// routers
router.post("/", async (req, res) => {
  const { body } = req;
  const userPrompt = JSON.stringify(body);
  const result = await generateAnswer(userPrompt);
  console.log(result);
  res.json(result.content);
});


module.exports = router;