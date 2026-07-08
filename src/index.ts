import "dotenv/config";
import app, { server } from "./app.js";
import mongoose from "mongoose";
import type { Request, Response } from "express";

const dev = process.env.NODE_ENV !== "production";

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  throw new Error("MONGO_URI is not defined");
}

// Connect to MongoDB Atlas
try {
  await mongoose.connect(MONGO_URI);
  console.log("MongoDB Connected Successfully");
} catch (error) {
  console.error("MongoDB Connection Error:", error);
  process.exit(1);
}

// Define a simple route for testing
app.get("/api", (req: Request, res: Response) => {
  res.json({ message: "Hello from Express API!" });
});

app.use((err: any, req: any, res: any, next: any) => {
  console.error(err);
  res.status(500).json({
    status: "error",
    message: err?.message ?? "Internal Server Error",
  });
});

// Use HTTP server (not app) to support WebSocket upgrades
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`WebSocket available at ws://localhost:${PORT}/ws/trades`);
});

