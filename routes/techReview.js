// imports
const express = require("express");
const dotenv = require("dotenv");
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const {
  techPrompt,
  lawPrompt,
  ocrPrompt,
} = require("../prompts/techReviewPrompt");
const keyFilename = "doc_ai_key.json";

// config
dotenv.config();
const router = express.Router();

// azure
const client = new OpenAIClient(
  process.env.AZURE_ENDPOINT,
  new AzureKeyCredential(process.env.AZURE_KEY)
);

// pinecone
const pc = new Pinecone({ apiKey: process.env.PINECONE_KEY });
const index = pc.index(process.env.PINECONE_INDEX);

//Document AI
const { DocumentProcessorServiceClient } =
  require("@google-cloud/documentai").v1;
const docAIClient = new DocumentProcessorServiceClient({ keyFilename });

//pdf file to text
const getOCRText = async (pdfFile) => {
  try {
    const name = `projects/${process.env.DOC_AI_PROJECT_ID}/locations/${process.env.DOC_AI_LOCATION}/processors/${process.env.DOC_AI_OCR_PROCESSOR_ID}`;
    //FIXME: PDF 파일을 base64로 인코딩
    // const fs = require("fs").promises;
    // const imageFile = await fs.readFile("test2.pdf");
    const encodedImage = Buffer.from(imageFile).toString("base64");

    const request = {
      name,
      rawDocument: {
        content: encodedImage,
        mimeType: "application/pdf",
      },
    };
    const [result] = await docAIClient.processDocument(request);
    const { document } = result;
    console.log(document);
    return document.text;
  } catch (err) {
    console.error(err);
  }
};

// get user prompt from ocr text
const getUserPrompt = async (ocrText) => {
  try {
    const dialogue = [
      {
        role: "system",
        content: ocrPrompt,
      },
      { role: "user", content: ocrText },
    ];
    const response = await client.getChatCompletions(
      process.env.AZURE_GPT,
      dialogue
    );
    console.log(response.choices[0].message);
    return response.choices[0].message.content;
  } catch (err) {
    console.error(err);
  }
};

// sentence -> embedding
const getEmbedding = async (t) => {
  try {
    const embedding = await client.getEmbeddings(process.env.AZURE_EMBEDDING, [
      t,
    ]);
    return embedding.data[0].embedding;
  } catch (err) {
    console.error(err);
  }
};

// 선행기술 DB 검토
const queryToTechIndex = async (userPrompt) => {
  try {
    const embedding = await getEmbedding(userPrompt);
    const result = await index.namespace("prior_patent").query({
      topK: 5,
      vector: embedding,
      includeMetadata: true,
    });
    console.log(JSON.stringify(result.matches[0].metadata));
    return result;
  } catch (err) {
    console.error(err);
  }
};

// 특허법 DB 검토
const queryToLawIndex = async (techResponse) => {
  const embedding = await getEmbedding(techResponse);
  const result = await index.namespace("patent_law").query({
    topK: 3,
    vector: embedding,
    includeMetadata: true,
  });
  console.log(result.matches[0].metadata);
  return result;
};

// 답변 생성
const generateAnswer = async (userPrompt) => {
  try {
    // 선행기술 DB 탐색 결과
    const techReviewResult = await queryToTechIndex(userPrompt);

    // 대화 생성
    const dialogue = [
      {
        role: "system",
        content:
          techPrompt +
          JSON.stringify(techReviewResult.matches[0].metadata) +
          JSON.stringify(techReviewResult.matches[1].metadata) +
          JSON.stringify(techReviewResult.matches[2].metadata) +
          JSON.stringify(techReviewResult.matches[3].metadata) +
          JSON.stringify(techReviewResult.matches[4].metadata),
      },
      { role: "system", content: lawPrompt },
      { role: "user", content: userPrompt },
    ];

    // 선행기술 검토 답변
    const techResponse = await client.getChatCompletions(
      process.env.AZURE_GPT,
      dialogue
    );
    console.log(techResponse.choices[0].message);

    // 특허법 DB 탐색 결과
    const lawReviewResult = await queryToLawIndex(
      techResponse.choices[0].message.content
    );

    // 대화 추가
    dialogue.push(techResponse.choices[0].message);
    dialogue.push({
      role: "system",
      content:
        lawPrompt +
        JSON.stringify(lawReviewResult.matches[0].metadata) +
        JSON.stringify(lawReviewResult.matches[1].metadata) +
        JSON.stringify(lawReviewResult.matches[2].metadata),
    });

    // 특허법 검토 답변
    const lawResponse = await client.getChatCompletions(
      process.env.AZURE_GPT,
      dialogue
    );
    return lawResponse.choices[0].message;
  } catch (err) {
    console.error(err);
  }
};

// routers
router.post("/", async (req, res) => {
  const { body } = req;
  const userPrompt = JSON.stringify(body);
  // pdf 파일로 text 추출 -> 필드별로 분류하여 json 생성 -> 기존 userPrompt 대체
  // const ocrText = await getOCRText(pdfFile);
  // const userPrompt = await getUserPrompt(ocrText);
  const result = await generateAnswer(userPrompt);
  console.log(result);
  res.json(result.content);
});

module.exports = router;
