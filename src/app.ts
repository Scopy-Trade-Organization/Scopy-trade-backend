import express from "express";
import compression from "compression";
import "dotenv/config";
import helmet from "helmet";
import passport from "passport";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import cors from "cors";
import { createServer } from "http";
import { TradeWebSocketServer } from "./websocket/server.js";
import { getTradeMonitorService } from "./services/tradeMonitorService.js";
import {
  startTradeStatusJob,
  stopTradeStatusJob,
} from "./services/tradeStatusJob.js";
import authRouter from "./routes/userAuthRoutes.js";
import exchangeRouter from "./routes/exchangeRoutes.js";
import adminDashboardRouter from "./routes/adminDashboardRoutes.js";
import tradeRouter from "./routes/tradeRoutes.js";
import adminAuthRouter from "./routes/adminAuthRoutes.js";
import { sanitize } from "./middleware/mongodbSantizer.js";
import proTraderDashboardRouter from "./routes/proTraderDashboardRoutes.js";
import copyTraderDashboardRouter from "./routes/copyTraderDashboardRoutes.js";
// import "./config/passport.js";

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 70,
  message: "Too many requests from this IP, please try again later",
});

const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.FRONTEND_LOCALHOST,
].filter(Boolean) as string[];

const app = express();
const server = createServer(app);

// ─── WebSocket Server ────────────────────────────────────────────────────────
const wsServer = new TradeWebSocketServer(server);

// ─── Trade Monitor Service ───────────────────────────────────────────────────
const tradeMonitor = getTradeMonitorService();

// Resume monitoring active trades after startup
// (Delayed to allow MongoDB to fully connect in index.ts)
setTimeout(() => {
  startTradeStatusJob();
  tradeMonitor
    .resumeActiveMonitoring()
    .then(() => {
      console.log("[App] Trade monitor resumed active monitoring");
    })
    .catch((err) => {
      console.error("[App] Failed to resume trade monitoring:", err);
    });
}, 3000);

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
async function gracefulShutdown() {
  console.log("[App] Shutting down gracefully...");
  wsServer.shutdown();
  stopTradeStatusJob();
  await tradeMonitor.shutdown();
  server.close(() => {
    console.log("[App] Server closed");
    process.exit(0);
  });
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

app.get("/ip", async (_, res) => {
  const response = await fetch("https://api.ipify.org?format=json");
  const data = await response.json();
  res.json(data);
});

// Middleware
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

app.set("trust proxy", 1);

app.use("/api", passport.initialize());
app.use("/api", express.json());
app.use("/api", compression());
app.use("/api", cookieParser());
app.use("/api", express.urlencoded({ extended: true }));
app.use("/api", helmet());
app.use("/api", limiter);
app.use((req, res, next) => {
  req.body = sanitize(req.body);
  req.params = sanitize(req.params);

  for (const key in req.query) {
    if (key.startsWith("$") || key.includes(".")) {
      delete req.query[key];
    }
  }
  next();
});

// Define API routes
app.use("/api/auth", authRouter);
app.use("/api/exchanges", exchangeRouter);
app.use("/api/admin/dashboard", adminDashboardRouter);
app.use("/api/admin/auth", adminAuthRouter);
app.use("/api/pro-trader/dashboard", proTraderDashboardRouter);
app.use("/api/copy-trader/dashboard", copyTraderDashboardRouter);
app.use("/api/trades", tradeRouter);

export { server };
export default app;

