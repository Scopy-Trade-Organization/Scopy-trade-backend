import "dotenv/config";
import app, { initializeTradeMonitoring, server } from "./app.js";
import mongoose from "mongoose";
import type { Request, Response } from "express";

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  throw new Error("MONGO_URI is not defined");
}

// Connect to MongoDB Atlas
try {
  await mongoose.connect(MONGO_URI);
  console.log("MongoDB Connected Successfully");
  await initializeTradeMonitoring();
} catch (error) {
  console.error("Application initialization error:", error);
  process.exit(1);
}

// Define a simple route for testing
app.get("/api", (req: Request, res: Response) => {
  res.json({ message: "Hello from Express API!" });
});

app.use((err: any, req: any, res: any, _next: any) => {
  console.error("Unhandled request error", { method: req.method, path: req.originalUrl, name: err?.name });
  const status = err?.type === "entity.too.large" ? 413 : 500;
  res.status(status).json({
    status: "error",
    message: status === 413 ? "Request body is too large" : "Internal Server Error",
  });
});

// Use HTTP server (not app) to support WebSocket upgrades
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`WebSocket available at ws://localhost:${PORT}/ws/trades`);
});

