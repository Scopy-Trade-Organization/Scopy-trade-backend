import express from "express";
import {
  registerUser,
  login,
  // handleGoogleLogin,
  // googleAuthCallback,
  logout,
  whoami,
  refreshToken,
  resendSignupOtp,
  verifySignupOtp,
  requestPasswordReset,
  resetPassword,
} from "../controllers/authControllers.js";
import { userAuthenticate } from "../middleware/authenticationMiddleware.js";
import { loginLimiter, registrationLimiter } from "../middleware/authRateLimit.js";

const userAuthRouter = express.Router();

userAuthRouter.post("/register", registrationLimiter, registerUser); // User Registration routes
userAuthRouter.post("/verify-signup", loginLimiter, verifySignupOtp);
userAuthRouter.post("/resend-signup-otp", registrationLimiter, resendSignupOtp);
userAuthRouter.post("/forgot-password", registrationLimiter, requestPasswordReset);
userAuthRouter.post("/reset-password", loginLimiter, resetPassword);

userAuthRouter.post("/login", loginLimiter, login); // User Login route

userAuthRouter.post("/refresh", refreshToken); // User Refresh Token route

userAuthRouter.get("/me", userAuthenticate, whoami); // User Info route

userAuthRouter.post("/logout", userAuthenticate, logout); // User Logout route

// Google OAuth
// userAuthRouter.get("/google", handleGoogleLogin);

// userAuthRouter.get("/google/callback", googleAuthCallback);

export default userAuthRouter;
