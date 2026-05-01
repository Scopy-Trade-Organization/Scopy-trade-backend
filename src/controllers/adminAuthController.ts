import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import Admin from "../models/adminModel.js";
import AuditLog from "../models/auditLogModel.js";
import { LoginRequestBody } from "../types/index.js";

const signAdminToken = (id: string): string => {
  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_EXPIRES_IN;

  if (!secret) throw new Error("JWT_SECRET is not defined");
  if (!expiresIn) throw new Error("JWT_EXPIRES_IN is not defined");

  return jwt.sign({ id }, secret, {
    expiresIn: expiresIn as NonNullable<SignOptions["expiresIn"]>,
  });
};

export const adminLogin = async (
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

    const admin = await Admin.findOne({ email }).select("+password");

    if (!admin || !admin.password) {
      return res.status(401).json({
        status: "fail",
        message: "Invalid credentials",
      });
    }

    const isPasswordValid = await bcrypt.compare(password, admin.password);
    if (!isPasswordValid) {
      return res.status(401).json({
        status: "fail",
        message: "Invalid credentials",
      });
    }

    const token = signAdminToken(admin._id.toString());
    admin.password = null;

    await AuditLog.create({
      action: "Admin login attempt",
      admin: admin._id,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";

    res.cookie("admin_token", token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? "none" : "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      status: "success",
      data: { admin },
    });
  } catch (err: any) {
    console.error("Admin login error:", err);

    return res.status(500).json({
      status: "error",
      message: "Login failed due to server error",
      details: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

export const adminLogout = (req: Request, res: Response) => {
  const isProduction = process.env.COOKIE_SECURE === "true";

  res.clearCookie("admin_token", {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
  });

  res.status(200).json({
    status: "success",
    message: "Logged out successfully",
  });
};
