import { Request, Response, NextFunction } from "express";
import User from "../models/userModel.js";
import Admin from "../models/adminModel.js";
import { verifyToken } from "../helpers/jwtHelper.js";

// Protection Middleware
export const userAuthenticate = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let token = req.cookies.user_token;

    if (!token) {
      return res.status(401).json({
        status: "fail",
        message: "Not authorized, no token",
      });
    }

    const decoded = verifyToken(token, "user");

    const currentUser = await User.findById(decoded.sub).select("+sessionVersion");
    if (!currentUser || currentUser.sessionVersion !== decoded.sv) throw new Error("Invalid session");

    req.user = currentUser._id;
    return next();
  } catch (err: any) {
    console.error("Protect error:", err);
    return res.status(401).json({
      status: "fail",
      message: "Invalid or expired session",
    });
  }
};

export const adminAuthenticate = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let token = req.cookies.admin_token;

    if (!token) {
      return res.status(401).json({
        status: "fail",
        message: "Not authorized, no token",
      });
    }

    const decoded = verifyToken(token, "admin");

    const currentUser = await Admin.findById(decoded.sub).select("+sessionVersion");
    if (!currentUser || currentUser.sessionVersion !== decoded.sv) throw new Error("Invalid session");

    req.admin = currentUser._id;
    return next();
  } catch (err: any) {
    console.error("Protect error:", err);
    return res.status(401).json({
      status: "fail",
      message: "Invalid or expired session",
    });
  }
};

export function requireRole(allowedRoles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          status: "error",
          message: "Authentication required",
        });
      }

      const user = await User.findById(req.user);

      if (!user) {
        return res.status(401).json({
          status: "error",
          message: "User not found",
        });
      }

      if (!allowedRoles.includes(user.role)) {
        return res.status(403).json({
          status: "error",
          message: "Insufficient permissions",
        });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}
