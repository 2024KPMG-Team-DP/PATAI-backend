// import modules
const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const pdf = require("pdf-creator-node");
const fs = require("fs");
// import files
const { techPrompt, lawPrompt, ocrPrompt } = require("../prompts/techReviewPrompt");
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
// Document AI
const { DocumentProcessorServiceClient } = require("@google-cloud/documentai").v1;
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
    if (file.mimetype === "application/pdf") { cb(null, true); }
    else { cb(new Error("Not a PDF file!"), false); }
  },
});


// pdf file to text
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
      { role: "system", content: ocrPrompt },
      { role: "user", content: ocrText },
    ];
    const response = await client.getChatCompletions(process.env.AZURE_GPT, dialogue, { seed: 42 });
    console.log(response.choices[0].message);

    // backtick(`) handling
    let result = response.choices[0].message.content;
    if (result[0]==='`') {
      result = result.slice(7);
      result = result.slice(0, -4);
    }

    return result;
  } catch (err) { console.error(err); }
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
      topK: 3,
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

// 보고서 항목 객체
const getReportFields = (body, response) => {
  const date = new Date();

  const data = {
    info: {
      name: body.name,
      company: body.organization,
      report: "등록가능성 진단보고서",
      nowDate: `${date.getFullYear()}년 ${date.getMonth()+1}월 ${date.getDate()}일`,
      summary: body.description
    },
    result: {
      otherPatents: [],
      conclusion: response.conclusion,
      guide: response.guide
    }
  }

  for (let i=0; i<response.similars.length; i++) {
    const patent = {
      index: i+1,
      name: response.similars[i].name,
      registration: response.similars[i].registration,
      registerDate: "",
      company: "",
      analysis: response.similars[i].analysis,
      similarity: response.similars[i].similarity
    };
    data.result.otherPatents.push(patent);
  }

  console.log(data);

  return data;
}

// 보고서 작성
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
    const response = await client.getChatCompletions(process.env.AZURE_GPT, dialogue, { seed: 42 });
    
    // backtick(`) handling
    let result = response.choices[0].message.content;
    if (result[0]==='`') {
      result = result.slice(7);
      result = result.slice(0, -4);
    }

    // 보고서 항목
    const data = getReportFields(body, JSON.parse(result));

    // 보고서 생성
    const document = {
      html: reportTemplate,
      data: { info: data.info, result: data.result },
      path: "./output.pdf",
      type: "buffer"
    };
    const report = await pdf.create(document, reportOption);
    return { pdf: report.toString("base64"), data };
  } catch (err) { console.error(err); }
}


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
      const result = await generateReport(JSON.parse(userPrompt), userPrompt);
      console.log("Result: ", result);

      // response
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", "attachment; filename=report.pdf");
      res.send(result);
    } catch (error) {
      console.error(error);
      res.status(500).send("Error processing PDF file.");
    }
  } else {
    res.status(400).send("No PDF file uploaded or file is not a PDF.");
  }
});

module.exports = router;
