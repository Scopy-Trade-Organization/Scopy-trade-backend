import { Request, Response } from "express";
import bcrypt from "bcrypt";
import User from "../models/userModel.js";
import jwt from "jsonwebtoken";
import validator from "validator";
import { LoginRequestBody, RegisterRequestBody } from "../types/index.js";
import AuditLog from "../models/auditLogModel.js";
import { signAccessToken, signRefreshToken } from "../helpers/jwtHelper.js";
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
    const { firstName, lastName, email, password, role, confirmPassword } =
      req.body;

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
    const existingUser = await User.findOne({ email });
    if (existingUser && existingUser.isVerified) {
      return res.status(400).json({
        status: "fail",
        message: "User is already registered and verified",
      });
    } else {
      // Create new user
      await User.create({
        email,
        password: hashedPassword,
        firstName,
        lastName,
        role,
        traderID:
          role === "CopyTrader"
            ? generateCopyTraderID()
            : generateProTraderID(),
      });
    }

    // Respond with success
    return res.status(201).json({
      status: "success",
      message: "User registered successfully",
    });
  } catch (err: any) {
    console.error("Error registering user:", err);
    return res.status(500).json({
      status: "error",
      message: "Registration failed",
      error: err.message,
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

    const user = await User.findOne({ email }).select("+password");

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

    // if (!user.isVerified) {
    //   return res.status(401).json({
    //     status: "fail",
    //     message: "Account not verified"
    //   });
    // }

    const accessToken = signAccessToken(user._id.toString());
    user.password = null;

    await AuditLog.create({
      action: "User login attempt",
      user: user._id,
      userEmail: user.email,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";

    res.cookie("user_token", accessToken, {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? "none" : "lax", // "none" requires secure:true
      maxAge: 24 * 60 * 60 * 1000,
    });

    if (rememberMe) {
      const refreshToken = signRefreshToken(user._id.toString());

      res.cookie("refresh_token", refreshToken, {
        httpOnly: true,
        secure: isSecure,
        sameSite: "none",
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
      details: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

export const logout = (req: Request, res: Response) => {
  const isProduction = process.env.COOKIE_SECURE === "true";

  res.cookie("user_token", {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

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
      data: { user },
    });
  } catch (err: any) {
    console.error("Error fetching user info:", err);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch user info",
      error: err.message,
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
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";

    const refreshSecret = process.env.JWT_SECRET;
    if (!refreshSecret) {
      throw new Error("JWT_SECRET is not defined");
    }

    const decoded = jwt.verify(refreshToken, refreshSecret) as {
      id: string;
      type: string;
    };

    if (!decoded || decoded.type !== "refresh") {
      res.clearCookie("refresh_token", {
        httpOnly: true,
        secure: isSecure,
        sameSite: "none",
        path: "/api/auth/refresh",
      });
      return res.status(401).json({
        status: "fail",
        message: "Invalid or expired refresh token",
      });
    }

    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      return res.status(401).json({
        status: "fail",
        message: "User not found",
      });
    }

    const newAccessToken = signAccessToken(user._id.toString());

    res.cookie("access_token", newAccessToken, {
      httpOnly: true,
      secure: isSecure,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      status: "success",
      data: { user },
    });
  } catch (err: any) {
    console.error("Refresh token error:", err);

    return res.status(401).json({
      status: "error",
      message: "Failed to refresh access token",
      details: err.message,
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
