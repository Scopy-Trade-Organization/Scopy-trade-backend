import express from "express";
import {
  registerUser,
  login,
  // handleGoogleLogin,
  // googleAuthCallback,
  logout,
} from "../controllers/authControllers.js";

const userAuthRouter = express.Router();

userAuthRouter.post("/register", registerUser); // User Registration routes

userAuthRouter.post("/login", login); // User Login route

userAuthRouter.post("/logout", logout); // User Logout route

// Google OAuth
// userAuthRouter.get("/google", handleGoogleLogin);

// userAuthRouter.get("/google/callback", googleAuthCallback);

export default userAuthRouter;
