// import modules
const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const pdf = require("pdf-creator-node");
const fs = require("fs");

// import files
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
// pdf creator
const reportTemplate = fs.readFileSync(`${__dirname}/../templates/techReviewTemplate.html`, "utf-8");
const reportOption = {
  format: "A4",
  orientation: "portrait",
  border: "10mm"
};

//Document AI
const { DocumentProcessorServiceClient } =
  require("@google-cloud/documentai").v1;
const docAIClient = new DocumentProcessorServiceClient({ keyFilename });

// Configure multer for PDF file storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/"); // specify the directory to store files
  },
  filename: function (req, file, cb) {
    cb(null, file.fieldname + "-" + Date.now() + ".pdf"); // generate a unique filename
  },
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Not a PDF file!"), false);
    }
  },
});

//pdf file to text
const getOCRText = async (pdfFilePath) => {
  try {
    const name = `projects/${process.env.DOC_AI_PROJECT_ID}/locations/${process.env.DOC_AI_LOCATION}/processors/${process.env.DOC_AI_OCR_PROCESSOR_ID}`;
    //FIXME: PDF 파일을 base64로 인코딩
    const fs = require("fs").promises;
    // const imageFile = await fs.readFile("test2.pdf");

    const pdfFile = await fs.readFile(pdfFilePath); // Read the PDF file
    const encodedImage = pdfFile.toString("base64");

    const request = {
      name,
      rawDocument: {
        content: encodedImage,
        mimeType: "application/pdf",
      },
    };
    const [result] = await docAIClient.processDocument(request);
    const { document } = result;
    console.log("document: ", document);
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
  } catch (err) { console.error(err); }
}

// 보고서 생성
const generateReport = async (body, userPrompt) => {
  try {
    // 선행기술 DB 탐색 결과
    const techReviewSearchResult = await queryToTechIndex(userPrompt);

    // 대화 생성
    const dialogue = [
      {
        role: "system",
        content: techPrompt
        + JSON.stringify(techReviewSearchResult.matches[0].metadata)
        + JSON.stringify(techReviewSearchResult.matches[1].metadata)
        + JSON.stringify(techReviewSearchResult.matches[2].metadata)
        // + JSON.stringify(techReviewSearchResult.matches[3].metadata)
        // + JSON.stringify(techReviewSearchResult.matches[4].metadata)
      },
      { role: "system", content: lawPrompt },
      { role: "user", content: userPrompt }
    ];

    // 답변
    const response = await client.getChatCompletions(process.env.AZURE_GPT, dialogue);
    const date = new Date();

    // 보고서 항목
    const data = {
      info: {
        registration: "",
        registerDate: body.date,
        company: body.organization,
        nowDate: `${date.getFullYear()}년 ${date.getMonth()}월 ${date.getDate()}일`,
        name: body.name,
        report: "등록가능성 진단보고서",
        summary: body.description
      },
      result: {
        otherPatents: [
          {
            index: techReviewSearchResult.matches[0].id,
            registration: techReviewSearchResult.matches[0].metadata.registration,
            registerDate: "",
            company: "",
            name: techReviewSearchResult.matches[0].metadata.name,
            similarity: ""
          },
          {
            index: techReviewSearchResult.matches[1].id,
            registration: techReviewSearchResult.matches[1].metadata.registration,
            registerDate: "",
            company: "",
            name: techReviewSearchResult.matches[1].metadata.name,
            similarity: ""
          },
          {
            index: techReviewSearchResult.matches[2].id,
            registration: techReviewSearchResult.matches[2].metadata.registration,
            registerDate: "",
            company: "",
            name: techReviewSearchResult.matches[2].metadata.name,
            similarity: ""
          },
        ],
        opinion: response.choices[0].message.content,
        probability: ""
      }
    }

    // 보고서 생성
    const document = {
      html: reportTemplate,
      data: { info: data.info, result: data.result },
      path: "./output.pdf",
      type: "buffer"
    };
    const result = await pdf.create(document, reportOption);
    return result;
  } catch (err) { console.error(err); }
}


// // routers
// router.post("/", async (req, res) => {
//   const { body } = req;
//   const userPrompt = JSON.stringify(body);
//   const result = await generateReport(body, userPrompt);
//   res.setHeader("Content-Type", "application/pdf");
//   res.setHeader("Content-Disposition", "attachment; filename=report.pdf");
//   res.send(result);
//   // console.log(result);
//   // res.json(result.content);

// routers
router.post("/", upload.single("pdf"), async (req, res) => {
  if (req.file && req.file.mimetype === "application/pdf") {
    console.log("Uploaded: ", req.file);
    // Process the PDF with OCR
    try {
      // pdf 파일로 text 추출
      const ocrText = await getOCRText(req.file.path);
      console.log(`Extracted OCR Text: ${ocrText}`);

      // 필드별로 분류하여 json 생성
      const userPrompt = await getUserPrompt(ocrText);
      console.log("User Prompt: ", userPrompt);

      // Proceed with the rest of your processing
      const result = await generateAnswer(userPrompt);
      console.log("Result: ", result);
      res.json(result.content);
    } catch (error) {
      console.error(error);
      res.status(500).send("Error processing PDF file.");
    }
  } else {
    res.status(400).send("No PDF file uploaded or file is not a PDF.");
  }
});

module.exports = router;
