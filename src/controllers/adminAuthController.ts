import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import Admin from "../models/adminModel.js";
import AuditLog from "../models/auditLogModel.js";
import { LoginRequestBody } from "../types/index.js";
import { signAccessToken, signRefreshToken } from "../helpers/jwtHelper.js";

export const adminLogin = async (
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

    const token = signAccessToken(admin._id.toString());
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
      maxAge: 24 * 60 * 60 * 1000,
    });

    if (rememberMe) {
      const refreshToken = signRefreshToken(admin._id.toString());

      res.cookie("refresh_token", refreshToken, {
        httpOnly: true,
        secure: isSecure,
        sameSite: "none",
        path: "/api/admin/auth/refresh", // very important
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });
    }

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

export const adminWhoami = async (req: Request, res: Response) => {
  try {
    const admin = await Admin.findById(req.admin).select("-password");

    if (!admin) {
      return res.status(404).json({
        status: "fail",
        message: "Admin not found",
      });
    }

    return res.status(200).json({
      status: "success",
      data: { admin },
    });
  } catch (err: any) {
    console.error("Error fetching admin info:", err);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch admin info",
      error: err.message,
    });
  }
};

export const AdminRefreshToken = async (req: Request, res: Response) => {
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
        path: "/api/admin/auth/refresh",
      });
      return res.status(401).json({
        status: "fail",
        message: "Invalid or expired refresh token",
      });
    }

    const admin = await Admin.findById(decoded.id).select("-password");
    if (!admin) {
      return res.status(401).json({
        status: "fail",
        message: "Admin not found",
      });
    }

    const newAccessToken = signAccessToken(admin._id.toString());

    res.cookie("admin_token", newAccessToken, {
      httpOnly: true,
      secure: isSecure,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      status: "success",
      data: { admin },
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
