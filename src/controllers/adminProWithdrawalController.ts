import type { Request, Response } from "express";
import mongoose from "mongoose";
import rateLimit from "express-rate-limit";
import User from "../models/userModel.js";
import { ProWithdrawal } from "../models/proFinanceModel.js";
import { publicWithdrawal } from "./proFinanceController.js";
import { reconcileProWithdrawal, ReconciliationError } from "../services/proFinanceService.js";

export const reconciliationLimit = rateLimit({ windowMs: 60_000, limit: 20,
  keyGenerator: req => String(req.admin), standardHeaders: "draft-8", legacyHeaders: false,
  message: { success: false, message: "Please wait before checking the blockchain again." } });

function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try { await fn(req, res); }
    catch (error) {
      res.status(error instanceof ReconciliationError ? error.statusCode : 503).json({ success: false,
        message: error instanceof ReconciliationError ? error.message : "Reconciliation service unavailable. Refresh the withdrawal before retrying." });
    }
  };
}
function withdrawalId(req: Request) {
  if (typeof req.params.id !== "string" || !/^[a-f0-9]{24}$/i.test(req.params.id)) throw new ReconciliationError("Invalid withdrawal ID.", 400);
  return new mongoose.Types.ObjectId(req.params.id);
}
async function adminWithdrawal(row: any) {
  const proTrader = await User.findById(row.userId).select("firstName lastName email traderID").lean();
  return { ...publicWithdrawal(row), userId: row.userId, proTrader,
    // Reasons written by the worker/reconciler are fixed messages, never node errors.
    reconciliationReason: row.lastError || null };
}
export const listProWithdrawals = handler(async (req, res) => {
  const page = Number(req.query.page || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new ReconciliationError("Invalid page.", 400);
  const status = req.query.status;
  if (status !== undefined && !["QUEUED", "SIGNED", "CONFIRMED", "FAILED", "REVIEW"].includes(String(status))) throw new ReconciliationError("Invalid status.", 400);
  const filter = status ? { status: String(status) } : {};
  const [rows, total] = await Promise.all([
    ProWithdrawal.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 20).limit(20).lean(),
    ProWithdrawal.countDocuments(filter),
  ]);
  res.json({ success: true, rows: await Promise.all(rows.map(adminWithdrawal)), page, pages: Math.max(1, Math.ceil(total / 20)), total });
});
export const getProWithdrawal = handler(async (req, res) => {
  const row = await ProWithdrawal.findById(withdrawalId(req)).lean();
  if (!row) throw new ReconciliationError("Withdrawal not found.", 404);
  res.json({ success: true, withdrawal: await adminWithdrawal(row) });
});
export const reconcileWithdrawal = handler(async (req, res) => {
  const result = await reconcileProWithdrawal(withdrawalId(req), req.admin!);
  res.json({ success: true, ...result, withdrawal: await adminWithdrawal(result.withdrawal) });
});
