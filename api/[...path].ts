import express from "express";
import { createApp } from "../src/app";

const app = createApp();

// Wrapper that rewrites incoming /api/* paths -> /* before Express route matching
const handler = express();

handler.use((req, _res, next) => {
  if (req.url.startsWith("/api/")) req.url = req.url.slice(4); // remove "/api"
  else if (req.url === "/api") req.url = "/";
  next();
});

handler.use(app);

export default handler;
