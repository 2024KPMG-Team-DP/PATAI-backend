// imports
const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");
const specGuidePrompt = require("../prompts/specGuidePrompt");

// import files
const keyFilename = "doc_ai_key.json";

// config
dotenv.config();
const router = express.Router();

// azure
const client = new OpenAIClient(
  process.env.AZURE_ENDPOINT,
  new AzureKeyCredential(process.env.AZURE_KEY)
);

// Document AI
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
      dialogue,
      { response_format: { type: "json_object" } }
    );
    return specResponse.choices[0].message;
  } catch (err) {
    console.error(err);
  }
};

// routers
router.post("/", upload.single("pdf"), async (req, res) => {
  if (req.file && req.file.mimetype === "application/pdf") {
    console.log("Uploaded: ", req.file);
    try {
      const ocrText = await getOCRText(req.file.path);
      const result = await generateAnswer(ocrText);
      console.log(result.content);
      const resultToJSON = JSON.parse(result.content);
      console.log(resultToJSON);
      res.json(resultToJSON);
    } catch (err) {
      console.error(err);
    }
  }
});

module.exports = router;
