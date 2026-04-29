import express from "express";
import compression from "compression";
import "dotenv/config";
import helmet from "helmet";
import passport from "passport";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import cors from "cors";
import authRouter from "./routes/userAuthRoutes.js";
import exchangeRouter from "./routes/exchangeRoutes.js";
import adminDashboardRouter from "./routes/adminDashboardRoutes.js";
import adminAuthRouter from "./routes/adminAuthRoutes.js";
import { sanitize } from "./middleware/mongodbSantizer.js";
// import "./config/passport.js";

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: "Too many requests from this IP, please try again later",
});

const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.FRONTEND_LOCALHOST,
].filter(Boolean) as string[];

const app = express();

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
// app.use("/api/user", userRouter);

export default app;
