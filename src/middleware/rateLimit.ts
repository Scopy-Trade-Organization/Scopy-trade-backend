// middlewares/rateLimit.ts
import rateLimit from "express-rate-limit";

export const connectionLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minute
  max: 4, // 4 requests per 10 minutes per IP
  message: {
    success: false,
    message: "Too many test requests. Please try again in an hour.",
  },
});
