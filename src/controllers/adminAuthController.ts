import { Request, Response } from "express";
import bcrypt from "bcrypt";
import Admin from "../models/adminModel.js";
import AuditLog from "../models/auditLogModel.js";
import { LoginRequestBody } from "../types/index.js";
import { signAccessToken, signRefreshToken, verifyToken } from "../helpers/jwtHelper.js";
import { csrfCookieOptions, isSecureRequest, setCsrfToken } from "../middleware/csrfProtection.js";

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

    const admin = await Admin.findOne({ email }).select("+password +sessionVersion");

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

    const token = signAccessToken(admin._id.toString(), "admin", admin.sessionVersion ?? 0);
    
    const adminObj = admin.toObject();
    delete adminObj.password;

    await AuditLog.create({
      action: "Admin login attempt",
      admin: admin._id,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    const isSecure = isSecureRequest(req);

    res.cookie("admin_token", token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000,
    });
    setCsrfToken(req, res);

    if (rememberMe) {
      const refreshToken = signRefreshToken(admin._id.toString(), "admin", admin.sessionVersion ?? 0);

      res.cookie("refresh_token", refreshToken, {
        httpOnly: true,
        secure: isSecure,
        sameSite: isSecure ? "none" : "lax",
        path: "/api/admin/auth/refresh", // very important
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });
    }

    return res.status(200).json({
      status: "success",
      data: { admin: adminObj },
    });
  } catch (err: any) {
    console.error("Admin login error:", err);

    return res.status(500).json({
      status: "error",
      message: "Login failed due to server error",
    });
  }
};

export const adminLogout = async (req: Request, res: Response) => {
  const isSecure = isSecureRequest(req);
  if (req.admin) await Admin.updateOne({ _id: req.admin }, { $inc: { sessionVersion: 1 } });
  res.clearCookie("admin_token", {
    httpOnly: true,
    secure: isSecure,
    sameSite: isSecure ? "none" : "lax",
  });
  res.clearCookie("refresh_token", { httpOnly: true, secure: isSecure, sameSite: isSecure ? "none" : "lax", path: "/api/admin/auth/refresh" });
  res.clearCookie("csrf_token", csrfCookieOptions(req));

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
      data: admin,
    });
  } catch (err: any) {
    console.error("Error fetching admin info:", err);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch admin info",
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
    const isSecure = isSecureRequest(req);
    const decoded = verifyToken(refreshToken, "admin", true);
    if (!decoded) {
      res.clearCookie("refresh_token", {
        httpOnly: true,
        secure: isSecure,
        sameSite: isSecure ? "none" : "lax",
        path: "/api/admin/auth/refresh",
      });
      return res.status(401).json({
        status: "fail",
        message: "Invalid or expired refresh token",
      });
    }

    const admin = await Admin.findById(decoded.sub).select("-password +sessionVersion");
    if (!admin || admin.sessionVersion !== decoded.sv) {
      return res.status(401).json({
        status: "fail",
        message: "Invalid or expired refresh token",
      });
    }

    const newAccessToken = signAccessToken(admin._id.toString(), "admin", admin.sessionVersion ?? 0);

    res.cookie("admin_token", newAccessToken, {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000,
    });
    setCsrfToken(req, res);

    return res.status(200).json({
      status: "success",
      data: { admin },
    });
  } catch (err: any) {
    console.error("Refresh token error:", err);

    return res.status(401).json({
      status: "error",
      message: "Failed to refresh access token",
    });
  }
};
