import type { Request, Response, NextFunction } from "express";
import type { Types } from "mongoose";
import User from "../models/userModel.js";

export async function requireLiveTrading(req: Request, res: Response, next: NextFunction) {
  try {
    // Temporary launch restriction, used only by the pro trade creation route.
    if (!await User.exists({ _id: req.user as Types.ObjectId, status: "live" })) {
      return res.status(403).json({ success: false, code: "TRADING_NOT_ENABLED", message: "Live trading is coming soon." });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}
