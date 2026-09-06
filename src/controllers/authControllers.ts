import { Request, Response } from "express";
import bcrypt from "bcrypt";
import User from "../models/userModel.js";
import validator from "validator";
import { LoginRequestBody, RegisterRequestBody } from "../types/index.js";
import AuditLog from "../models/auditLogModel.js";
import { signAccessToken, signRefreshToken, verifyToken } from "../helpers/jwtHelper.js";
import { csrfCookieOptions, isSecureRequest, setCsrfToken } from "../middleware/csrfProtection.js";
import { consumeOtp, issueOtp } from "../services/otpService.js";
import { queueEmail, sendOtpEmail, sendWelcomeEmail } from "../services/emailService.js";
// import passport from "passport";
// import { UserJwtPayload } from "../config/passport.js"; // import the interface

// Helper function to generate unique Trader IDs
export const generateCopyTraderID = () =>
  "SCT-" + Math.random().toString(36).substring(2, 10).toUpperCase();

export const generateProTraderID = () =>
  "SPT-" + Math.random().toString(36).substring(2, 10).toUpperCase();

// User Registration
export const registerUser = async (
  req: Request<{}, {}, RegisterRequestBody>,
  res: Response,
) => {
  try {
    const {
      firstName,
      lastName,
      email,
      password,
      role,
      confirmPassword,
      sponsored,
    } = req.body;

    // Validate user input
    if (
      !email ||
      !password ||
      !confirmPassword ||
      !firstName ||
      !lastName ||
      !role
    ) {
      return res.status(400).json({
        status: "fail",
        message: "All fields are required",
      });
    }

    // Check if passwords match
    if (password !== confirmPassword) {
      return res.status(400).json({
        status: "fail",
        message: "Passwords do not match",
      });
    }

    // Validate password strength
    if (
      !validator.isStrongPassword(password, {
        minLength: 8,
        minUppercase: 1,
        minSymbols: 1,
        minNumbers: 1,
      })
    ) {
      return res.status(400).json({
        status: "fail",
        message:
          "Password must be at least 8 characters and include an uppercase letter, number, and symbol",
      });
    }

    if (sponsored && role !== "CopyTrader") {
      return res.status(400).json({
        status: "fail",
        message: "Only CopyTraders can be sponsored",
      });
    } else if (sponsored !== undefined && typeof sponsored !== "boolean") {
      return res.status(400).json({
        status: "fail",
        message: "Invalid value for sponsored field",
      });
    }

    // Validate email format
    if (!validator.isEmail(email)) {
      return res.status(400).json({
        status: "fail",
        message: "Invalid email format",
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Check if user already exists
    // Check if user already exists
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      // User exists and verified
      if (existingUser.isVerified) {
        return res.status(400).json({
          status: "fail",
          message: "User is already registered and verified",
        });
      }

      // User exists but not verified
      const code = await issueOtp({ email: existingUser.email, purpose: "signup", userId: existingUser._id });
      await sendOtpEmail(existingUser.email, existingUser.firstName, code, "signup");
      return res.status(200).json({
        status: "success",
        message: "A new verification code has been sent to your email.",
        data: { email: existingUser.email },
      });
    }

    const signupStatus = process.env.SIGNUP_DEFAULT_STATUS === "active" ? "active" : "waitlist";

    // Create the account as unverified. It cannot be used until the emailed OTP is confirmed.
    const user = await User.create({
      email,
      password: hashedPassword,
      firstName,
      lastName,
      role,
      sponsored,
      traderID:
        role === "CopyTrader" ? generateCopyTraderID() : generateProTraderID(),
      status: signupStatus,
    });

    const code = await issueOtp({ email: user.email, purpose: "signup", userId: user._id });
    await sendOtpEmail(user.email, user.firstName, code, "signup");

    // Respond with success
    return res.status(201).json({
      status: "success",
      message: "Registration received. Check your email for the verification code.",
      data: { email: user.email },
    });
  } catch (err: any) {
    console.error("Error registering user:", err);
    return res.status(500).json({
      status: "error",
      message: "Registration failed",
    });
  }
};

// User Login
export const login = async (
  req: Request<{}, {}, LoginRequestBody>,
  res: Response,
) => {
  try {
    const { email, password, rememberMe } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        status: "fail",
        message: "Email and password required",
      });
    }

    const user = await User.findOne({ email }).select("+password +sessionVersion");

    // Check if user exists and has a password
    if (!user || !user.password) {
      return res.status(401).json({
        status: "fail",
        message: "Invalid credentials",
      });
    }

    // Verify both password and user.password are defined before comparing
    if (!password || !user.password) {
      return res.status(401).json({
        status: "fail",
        message: "Invalid credentials",
      });
    }

    // Compare passwords
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({
        status: "fail",
        message: "Invalid credentials",
      });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        status: "fail",
        code: "EMAIL_NOT_VERIFIED",
        message: "Verify your email before signing in.",
      });
    }

    if (user.status === "suspended") {
      return res.status(403).json({
        status: "fail",
        message: "Your account has been suspended. Please contact support.",
      });
    }

    // if (!user.isVerified) {
    //   return res.status(401).json({
    //     status: "fail",
    //     message: "Account not verified"
    //   });
    // }

    const accessToken = signAccessToken(user._id.toString(), "user", user.sessionVersion ?? 0);
    user.password = null;

    await AuditLog.create({
      action: "User login attempt",
      user: user._id,
      userEmail: user.email,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    const isSecure = isSecureRequest(req);

    res.cookie("user_token", accessToken, {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? "none" : "lax", // "none" requires secure:true
      maxAge: 24 * 60 * 60 * 1000,
    });
    setCsrfToken(req, res);

    if (rememberMe) {
      const refreshToken = signRefreshToken(user._id.toString(), "user", user.sessionVersion ?? 0);

      res.cookie("refresh_token", refreshToken, {
        httpOnly: true,
        secure: isSecure,
        sameSite: isSecure ? "none" : "lax",
        path: "/api/auth/refresh", // very important
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });
    }

    return res.status(200).json({
      status: "success",
      data: { user },
    });
  } catch (err: any) {
    console.error("Login error:", err);

    return res.status(500).json({
      status: "error",
      message: "Login failed due to server error",
    });
  }
};

export const resendSignupOtp = async (req: Request, res: Response) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const user = await User.findOne({ email, isVerified: false });
    if (user) {
      const code = await issueOtp({ email: user.email, purpose: "signup", userId: user._id });
      await sendOtpEmail(user.email, user.firstName, code, "signup");
    }
    return res.status(200).json({ status: "success", message: "If that registration exists, a new code has been sent." });
  } catch (error) {
    console.error("Error resending signup OTP:", error);
    return res.status(500).json({ status: "error", message: "Unable to send a verification code." });
  }
};

export const verifySignupOtp = async (req: Request, res: Response) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ status: "fail", message: "Invalid or expired verification code." });
    if (user.isVerified) {
      return res.status(200).json({ status: "success", message: "Email is already verified.", data: { status: user.status } });
    }
    if (!(await consumeOtp({ email, purpose: "signup", code: req.body.otp }))) {
      return res.status(400).json({ status: "fail", message: "Invalid or expired verification code." });
    }
    user.isVerified = true;
    await user.save();
    queueEmail("welcome email failed", () => sendWelcomeEmail(user.email, user.firstName, user.status as "active" | "waitlist"));
    return res.status(200).json({
      status: "success",
      message: "Email verified successfully.",
      data: { status: user.status },
    });
  } catch (error) {
    console.error("Error verifying signup OTP:", error);
    return res.status(500).json({ status: "error", message: "Email verification failed." });
  }
};

export const requestPasswordReset = async (req: Request, res: Response) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const user = await User.findOne({ email, isVerified: true });
    if (user) {
      const code = await issueOtp({ email: user.email, purpose: "password-reset", userId: user._id });
      await sendOtpEmail(user.email, user.firstName, code, "password-reset");
    }
    return res.status(200).json({ status: "success", message: "If an account exists for that email, a reset code has been sent." });
  } catch (error) {
    console.error("Error requesting password reset:", error);
    return res.status(500).json({ status: "error", message: "Unable to request a password reset." });
  }
};

export const resetPassword = async (req: Request, res: Response) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const { otp, password, confirmPassword } = req.body;
    if (!email || !otp || !password || !confirmPassword) {
      return res.status(400).json({ status: "fail", message: "Email, code, and both password fields are required." });
    }
    if (password !== confirmPassword) return res.status(400).json({ status: "fail", message: "Passwords do not match." });
    if (!validator.isStrongPassword(password, { minLength: 8, minUppercase: 1, minSymbols: 1, minNumbers: 1 })) {
      return res.status(400).json({ status: "fail", message: "Password must be at least 8 characters and include an uppercase letter, number, and symbol." });
    }
    const user = await User.findOne({ email, isVerified: true }).select("+sessionVersion");
    if (!user || !(await consumeOtp({ email, purpose: "password-reset", code: otp }))) {
      return res.status(400).json({ status: "fail", message: "Invalid or expired verification code." });
    }
    user.password = await bcrypt.hash(password, 12);
    user.sessionVersion = (user.sessionVersion ?? 0) + 1;
    await user.save();
    return res.status(200).json({ status: "success", message: "Password reset successfully." });
  } catch (error) {
    console.error("Error resetting password:", error);
    return res.status(500).json({ status: "error", message: "Password reset failed." });
  }
};

export const logout = async (req: Request, res: Response) => {
  const isSecure = isSecureRequest(req);
  if (req.user) await User.updateOne({ _id: req.user }, { $inc: { sessionVersion: 1 } });
  const options = { httpOnly: true, secure: isSecure, sameSite: isSecure ? "none" as const : "lax" as const };
  res.clearCookie("user_token", options);
  res.clearCookie("refresh_token", { ...options, path: "/api/auth/refresh" });
  res.clearCookie("csrf_token", csrfCookieOptions(req));

  res.status(200).json({
    status: "success",
    message: "Logged out successfully",
  });
};

export const whoami = async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.user).select("-password");

    if (!user) {
      return res.status(404).json({
        status: "fail",
        message: "User not found",
      });
    }

    return res.status(200).json({
      status: "success",
      data: user,
    });
  } catch (err: any) {
    console.error("Error fetching user info:", err);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch user info",
    });
  }
};

export const refreshToken = async (req: Request, res: Response) => {
  try {
    const refreshToken = req.cookies.refresh_token;
    if (!refreshToken) {
      return res.status(401).json({
        status: "fail",
        message: "Refresh token missing",
      });
    }
    const isSecure = isSecureRequest(req);
    const decoded = verifyToken(refreshToken, "user", true);
    if (!decoded) {
      res.clearCookie("refresh_token", {
        httpOnly: true,
        secure: isSecure,
        sameSite: isSecure ? "none" : "lax",
        path: "/api/auth/refresh",
      });
      return res.status(401).json({
        status: "fail",
        message: "Invalid or expired refresh token",
      });
    }

    const user = await User.findById(decoded.sub).select("-password +sessionVersion");
    if (!user || user.sessionVersion !== decoded.sv) {
      return res.status(401).json({
        status: "fail",
        message: "Invalid or expired refresh token",
      });
    }

    const newAccessToken = signAccessToken(user._id.toString(), "user", user.sessionVersion ?? 0);

    res.cookie("user_token", newAccessToken, {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000,
    });
    setCsrfToken(req, res);

    return res.status(200).json({
      status: "success",
      data: { user },
    });
  } catch (err: any) {
    console.error("Refresh token error:", err);

    return res.status(401).json({
      status: "error",
      message: "Failed to refresh access token",
    });
  }
};

// export const handleGoogleLogin = (
//   req: Request,
//   res: Response,
//   next: NextFunction,
// ) => {
//   passport.authenticate("google-user", {
//     scope: ["profile", "email"],
//     session: false,
//   })(req, res, next);
// };

// export const googleAuthCallback = (
//   req: Request,
//   res: Response,
//   next: NextFunction,
// ) => {
//   passport.authenticate(
//     "google-user",
//     { session: false },
//     (err: Error | null, user: UserJwtPayload | false) => {
//       if (err) return next(err);
//       if (!user)
//         return res.redirect(
//           `${process.env.FRONTEND_URL}/login?error=oauth_failed`,
//         );

//       const token = signToken(user.id);
//       const isProduction = process.env.COOKIE_SECURE === "true";

//       res.cookie("user_token", token, {
//         httpOnly: true,
//         secure: isProduction,
//         sameSite: isProduction ? "none" : "lax",
//         maxAge: 7 * 24 * 60 * 60 * 1000,
//       });
//       res.redirect(`${process.env.FRONTEND_URL}/dashboard`);
//     },
//   )(req, res, next);
// };
