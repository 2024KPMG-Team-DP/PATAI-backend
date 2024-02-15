// imports modules
const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");
const pdf = require("pdf-creator-node");
const fs = require("fs");
// import files
const { ocrPrompt } = require("../prompts/techReviewPrompt");
const specGuidePrompt = require("../prompts/specGuidePrompt");
const keyFilename = "doc_ai_key.json";

// config
dotenv.config();
const router = express.Router();
// azure
const client = new OpenAIClient(
  process.env.AZURE_ENDPOINT,
  new AzureKeyCredential(process.env.AZURE_KEY)
);
// pdf creator
const reportTemplate = fs.readFileSync(`${__dirname}/../templates/specGuideTemplate.html`, "utf-8");
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

// 보고서 항목 객체
const getReportFields = (body, response) => {
  const date = new Date();

  const data = {
    info: {
      name: body.name,
      company: body.organization,
      report: "명세서 작성 가이드",
      nowDate: `${date.getFullYear()}년 ${date.getMonth()+1}월 ${date.getDate()}일`,
      summary: body.description
    },
    result: {
      name: response.name,
      techField: response.techField,
      backgroundTech: response.backgroundTech,
      content: {
        problemToSolve: response.content.problemToSolve,
        methodForSolve: response.content.methodForSolve,
        effectOfInvent: response.content.effectOfInvent
      }
    }
  }

  return data;
}

// 답변 생성
const generateReport = async (body, userPrompt) => {
  try {
    // 대화 생성
    const dialogue = [
      { role: "system", content: specGuidePrompt },
      { role: "user", content: userPrompt },
    ];

    // 답변
    // const response = await client.getChatCompletions(process.env.AZURE_GPT, dialogue, { seed: 42, response_format: { type: "json_object" } });
    const response = await client.getChatCompletions(process.env.AZURE_GPT, dialogue, { seed: 1 });
    
    // backtick(`) handling
    let result = response.choices[0].message.content;
    if (result[0]==='`') {
      result = result.slice(7);
      result = result.slice(0, -4);
    }

    // 보고서 항목
    console.log("Response: ", result);
    const data = getReportFields(body, JSON.parse(result));
    console.log("Fields: ", data);

    // 보고서 생성
    const document = {
      html: reportTemplate,
      data: { info: data.info, result: data.result },
      path: "./output.pdf",
      type: "buffer"
    };
    const report = await pdf.create(document, reportOption);
    return report;
  } catch (err) { console.error(err); }
};


// routers
router.post("/", upload.single("pdf"), async (req, res) => {
  if (req.file && req.file.mimetype === "application/pdf") {
    console.log("Uploaded: ", req.file);
    try {
      // pdf 파일로 text 추출
      const ocrText = await getOCRText(req.file.path);
      console.log(`Extracted OCR Text: ${ocrText}`);

      // 필드별로 분류하여 json 생성
      const userPrompt = await getUserPrompt(ocrText);
      console.log("User Prompt: ", userPrompt);

      // Proceed with the rest of your processing
      const result = await generateReport(JSON.parse(userPrompt), ocrText);
      console.log("Result: ", result);

      // response
      res.setHeader("Content-Type", "application/pdf");
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
