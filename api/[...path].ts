import { createApp } from "../src/app";

// create the express app once
const app = createApp();

// Vercel will route /api/* to this file because of [...path]
export default app;
