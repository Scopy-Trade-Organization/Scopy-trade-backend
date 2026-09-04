import rateLimit from "express-rate-limit";

const message = { status: "fail", message: "Too many attempts. Please try again later." };

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message,
});

export const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message,
});
