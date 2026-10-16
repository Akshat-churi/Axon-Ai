import { createServer } from "http";
import { app } from "./app";

export { app };

async function startServer() {
  const port = Number(process.env.PORT || "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");

  const server = createServer(app);
  server.on("error", error => { console.error("Server failed:", error.message); process.exit(1); });
  server.listen(port, "0.0.0.0", () => console.log(`Server listening on port ${port}`));

  const { serveStatic, setupVite } = await import("./vite");
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
}

// Only start standalone listener when not running inside Vercel Serverless
if (!process.env.VERCEL) {
  startServer().catch(error => { console.error(error); process.exit(1); });
}
