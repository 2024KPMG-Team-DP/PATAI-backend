const express = require("express");
const dotenv = require("dotenv");
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");
const { Pinecone } = require("@pinecone-database/pinecone");


dotenv.config();
const router = express.Router();

const client = new OpenAIClient(process.env.AZURE_ENDPOINT, new AzureKeyCredential(process.env.AZURE_KEY));
const systemPrompt = `
너는 특허 정보에 대해 대답하는 특허 전문가 assistant이고, user가 보내는 아이디어 내용을 검토해줘야 해. 
지금부터는 문장 끝에 주어지는 Sources에 해당하는 내용만을 가지고 답변해야 하며, 
user가 입력한 내용과 Sources 간에 유사한 점을 비교해서 알려줘야 해. 
user input은 이제 특허로 출원하고자 하는 기술에 대한 정보를 담고 있어. user input을 구성하는 필드들에 대해 설명해줄게. 
name 뒤의 내용은 기술의 이름, 
description 뒤의 내용은 기술에 대한 설명, 
feature 뒤의 내용은 기술의 특징, 
problem 뒤의 내용은 기존 기술의 문제점, 
solve 뒤의 내용은 기술이 개선하는 점, 
function 뒤의 내용은 기술이 제공하는 기능, 
benefit 뒤의 내용은 기술을 통한 기대효과, 
composition 뒤의 내용은 기술의 구성에 대한 설명을 담고 있어. 
Sources에는 기존에 존재하는 여러개의 특허 정보가 담겨 있어. Sources를 구성하는 필드들에 대해 설명해줄게. 
registration 뒤의 내용은 등록번호, 
name 뒤의 내용은 발명의 명칭, 
summary 뒤의 내용은 요약, 
problemToSolve 뒤의 내용은 특허를 통해 해결하려는 문제점, 
methodForSolve 뒤의 내용은 문제를 해결할 수단, 
effectOfInvent 뒤의 내용은 특허를 통해 기대할 수 있는 효과를 설명해. 
만약 너가 봤을 때 Sources 중 입력 내용과 조금이라도 관련성이 있다고 판단되는 부분이 있다면 Sources를 바탕으로 답변하되, 
유사한 부분이 있다는 것은 문제가 될 수 있기 때문에 주의를 주듯 말해줘. 
Sources 중 유사한 특허가 여러 개 있다고 판단되면, 유사한 모든 특허들과의 유사성에 대해 모두 설명해야 하며, 
구분할 수 있게 모든 유사한 특허의 이름과 등록번호를 모두 말해줘야 해. 
주제 자체가 유사하지 않다고 하더라도, 기존 특허를 가지고 쉽게 생각해낼 수 있는 기술이라면 거절되는 경우가 많아. 
주제가 다르더라도 기술을 구현하는 방식에 유사성이 있다면 발명으로 인정받지 못 할 수 있어. 
따라서 전혀 유사성이나 관련성이 없는 게 아니라 조금이라도 공통점이 있다면 반드시 주의를 주고 검토를 권하도록 해. 
유사성이 전혀 없다고 판단되면, 유사한 특허가 존재하지 않습니다 라고 답변해줘. 
단, 유사성이 있다고 판단될 때는 유사한 특허가 존재합니다 라는 단순한 답변만 해서는 안돼. 
답변을 생성하는 과정에서 너의 배경 지식은 절대 사용하지 말고, 주어진 정보 외의 다른 말은 하지 마. 
추가로, 제공된 Sources를 바탕으로 답변을 생성했다는 언급은 하지 마. 
Sources: `;

const pc = new Pinecone({ apiKey: process.env.PINECONE_KEY });
const index = pc.index(process.env.PINECONE_INDEX);

const getEmbedding = async (t) => {
  try {
    const embedding = await client.getEmbeddings(process.env.AZURE_EMBEDDING, [t]);
    return embedding.data[0].embedding;
  } catch (err) { console.error(err); }
}

const queryToIndex = async (userPrompt, systemPrompt) => {
  try {
    const embedding = await getEmbedding(userPrompt);
    const result = await index.namespace("socks").query({
      topK: 5,
      vector: embedding,
      includeMetadata: true
    });
    // console.log(result.matches);
    console.log(JSON.stringify(result.matches[0].metadata));

    const msg = [
      {
        role: "system",
        content: systemPrompt
        + JSON.stringify(result.matches[0].metadata)
        + JSON.stringify(result.matches[1].metadata)
        + JSON.stringify(result.matches[2].metadata)
        + JSON.stringify(result.matches[3].metadata)
        + JSON.stringify(result.matches[4].metadata)
      },
      { role: "user", content: userPrompt }
    ];

    const res = await client.getChatCompletions(process.env.AZURE_GPT, msg);
    return res.choices[0].message;
  } catch (err) { console.error(err); }
}


// routers
router.post("/", async (req, res) => {
  const { body } = req;
  const result = await queryToIndex(JSON.stringify(body), systemPrompt);
  console.log(result);
  res.json(result.content);
});

module.exports = router;