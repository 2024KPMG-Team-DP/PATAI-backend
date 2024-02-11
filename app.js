// import modules
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const morgan = require("morgan");
// import routes
const techReviewRouter = require("./routes/techReview");


// config
dotenv.config();

// create app
const app = express();

// app setting
app.set("port", 3000);

// middlewares
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// routers
app.use("/techReview", techReviewRouter);

// error handling routers
app.use((req, res) => {
  const err = new Error(`${req.method} ${req.url} 라우터가 없습니다.`);
  res.status(404).json(err);
});
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json(err);
})


// start app
app.listen(app.get("port"), () => {
  console.log("Server running,,,");
});