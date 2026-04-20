// middlewares/rateLimit.ts
import rateLimit from "express-rate-limit";

export const testConnectionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 requests per minute per IP
  message: {
    success: false,
    message: "Too many test requests. Please wait a moment.",
  },
});
