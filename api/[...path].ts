import { createApp } from "../src/app";

const app = createApp();

// Vercel routes /api/* here. Your Express app defines routes without /api,
// so strip the prefix before handing off.
export default function handler(req: any, res: any) {
  if (req.url) req.url = req.url.replace(/^\/api/, "") || "/";
  return (app as any)(req, res);
}
