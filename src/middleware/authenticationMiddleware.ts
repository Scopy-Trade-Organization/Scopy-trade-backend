import { Request, Response, NextFunction } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import User from "../models/userModel.js";
import Admin from "../models/adminModel.js";

interface UserJwtPayload extends JwtPayload {
  id: string;
}

interface AdminJwtPayload extends JwtPayload {
  id: string;
}

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

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET as string,
    ) as UserJwtPayload;

    const currentUser = await User.findById(decoded.id);
    if (!currentUser) throw new Error("User not found");

    req.user = currentUser._id;
    return next();
  } catch (err: any) {
    console.error("Protect error:", err);
    const message =
      err.name === "JsonWebTokenError"
        ? "Invalid token"
        : err.name === "TokenExpiredError"
          ? "Session expired"
          : err.message;

    return res.status(401).json({
      status: "fail",
      message,
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

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET as string,
    ) as AdminJwtPayload;

    const currentUser = await Admin.findById(decoded.id);
    if (!currentUser) throw new Error("Admin not found");

    req.admin = currentUser._id;
    return next();
  } catch (err: any) {
    console.error("Protect error:", err);
    const message =
      err.name === "JsonWebTokenError"
        ? "Invalid token"
        : err.name === "TokenExpiredError"
          ? "Session expired"
          : err.message;

    return res.status(401).json({
      status: "fail",
      message,
    });
  }
};
