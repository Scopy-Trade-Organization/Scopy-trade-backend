import type { Request, Response, NextFunction } from "express";
import type { Types } from "mongoose";
import { hasLiveTradingAccess, TRADING_NOT_ENABLED_MESSAGE } from "../services/tradingAccessService.js";

export async function requireLiveTrading(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user || !await hasLiveTradingAccess(req.user as Types.ObjectId)) {
      return res.status(403).json({ success: false, code: "TRADING_NOT_ENABLED", message: TRADING_NOT_ENABLED_MESSAGE });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}
