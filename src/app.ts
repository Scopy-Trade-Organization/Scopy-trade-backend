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
import authRouter from "./routes/userAuthRoutes.js";
import exchangeRouter from "./routes/exchangeRoutes.js";
import adminDashboardRouter from "./routes/adminDashboardRoutes.js";
import tradeRouter from "./routes/tradeRoutes.js";
import adminAuthRouter from "./routes/adminAuthRoutes.js";
import { sanitize } from "./middleware/mongodbSantizer.js";
import { csrfProtection } from "./middleware/csrfProtection.js";
import proTraderDashboardRouter from "./routes/proTraderDashboardRoutes.js";
import copyTraderDashboardRouter from "./routes/copyTraderDashboardRoutes.js";
import { resumePendingProfitSettlements } from "./services/profitSharingService.js";
// import "./config/passport.js";

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 70,
  message: "Too many requests from this IP, please try again later",
  standardHeaders: "draft-8",
  legacyHeaders: false,
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

export async function initializeTradeMonitoring(): Promise<void> {
  await tradeMonitor.resumeActiveMonitoring();
  tradeMonitor.startBackgroundReconciliation();
  await resumePendingProfitSettlements();
  console.log("[App] Trade monitor resumed active monitoring");
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
async function gracefulShutdown() {
  console.log("[App] Shutting down gracefully...");
  wsServer.shutdown();
  await tradeMonitor.shutdown();
  server.close(() => {
    console.log("[App] Server closed");
    process.exit(0);
  });
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// Middleware
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS origin denied"));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token"],
  }),
);

app.set("trust proxy", 1);

app.use("/api", passport.initialize());
app.use("/api", express.json({ limit: "100kb" }));
app.use("/api", compression());
app.use("/api", cookieParser());
app.use("/api", express.urlencoded({ extended: false, limit: "100kb" }));
app.use("/api", helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
app.use("/api", limiter);
app.use((req, res, next) => {
  req.body = sanitize(req.body);
  req.params = sanitize(req.params);
  sanitize(req.query);
  next();
});
app.use("/api", csrfProtection);

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

