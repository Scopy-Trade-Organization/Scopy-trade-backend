import { Request, Response } from "express";
import bcrypt from "bcrypt";
import User from "../models/userModel.js";
import jwt, { SignOptions } from "jsonwebtoken";
import validator from "validator";
import { LoginRequestBody, RegisterRequestBody } from "../types/index.js";
// import passport from "passport";
// import { UserJwtPayload } from "../config/passport.js"; // import the interface

// Helper function to sign JWT tokens for User
const signToken = (id: string): string => {
  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_EXPIRES_IN;

  if (!secret) throw new Error("JWT_SECRET is not defined");
  if (!expiresIn) throw new Error("JWT_EXPIRES_IN is not defined");

  return jwt.sign({ id }, secret, {
    expiresIn: expiresIn as NonNullable<SignOptions["expiresIn"]>,
  });
};

// Helper function to generate unique donor IDs
export const generateUserID = () =>
  "AGU-" + Math.random().toString(36).substring(2, 10).toUpperCase();

// User Registration
export const registerUser = async (
  req: Request<{}, {}, RegisterRequestBody>,
  res: Response,
) => {
  try {
    const { firstName, lastName, email, password, confirmPassword } = req.body;

    // Validate user input
    if (!email || !password || !confirmPassword || !firstName || !lastName) {
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
        traderID: generateUserID(),
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
    const { email, password } = req.body;

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

    const token = signToken(user._id.toString());
    user.password = null;

    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";

    res.cookie("token", token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? "none" : "lax", // "none" requires secure:true
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

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
