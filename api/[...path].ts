import app from "../src/app";

// Vercel will route /api/* to this catch-all.
// Express app is a (req,res) handler as long as it does NOT call app.listen().
export default app;
