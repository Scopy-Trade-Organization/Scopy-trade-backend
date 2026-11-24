import { creditProEarning } from "./proFinanceService.js";
import User from "../models/userModel.js";
import { profitSplit, usdtUnits, formatUsdt } from "../helpers/usdt.js";
import mongoose from "mongoose";
import { Trade } from "../models/tradeModel.js";
import {
  PROFIT_SHARE_WITHDRAWAL_THRESHOLD,
} from "../constants.js";
import { queueTradeEmail } from "./emailService.js";

export interface TradeCloseResult {
  tradeId: string;
  realizedPnl: string;
  platformFee: string;
  feeStatus: "pending" | "processing" | "collected" | "failed" | "waived";
  tradeResult: "profit" | "loss" | "breakeven";
}

function calculateRealizedPnl(
  direction: "buy" | "sell",
  entryFillPrice: string,
  exitPrice: string,
  quantity: string,
): number {
  const entry = Number(entryFillPrice);
  const exit = Number(exitPrice);
  const qty = Number(quantity);
  if (![entry, exit, qty].every(Number.isFinite)) return 0;
  return direction === "buy" ? (exit - entry) * qty : (entry - exit) * qty;
}

function classifyResult(pnl: number): "profit" | "loss" | "breakeven" {
  if (pnl > 0) return "profit";
  if (pnl < 0) return "loss";
  return "breakeven";
}

/**
 * Persists the close exactly once. Profitable copy-trade fees remain pending
 * until the user's accrued 20% share reaches the collection threshold and the
 * user pays their dashboard settlement invoice.
 */
export async function processTradeClose(
  tradeId: string,
  exitPrice: string,
  closedVia: "tp" | "sl" | "manual",
): Promise<TradeCloseResult> {
  const trade = await Trade.findById(tradeId).lean();
  if (!trade) throw new Error(`[profitSharingService] Trade ${tradeId} not found.`);

  if (trade.status === "closed") {
    return {
      tradeId,
      realizedPnl: trade.realizedPnl || "0",
      platformFee: trade.platformFee || "0",
      feeStatus: (trade.feeStatus as TradeCloseResult["feeStatus"]) || "waived",
      tradeResult: trade.tradeResult || "breakeven",
    };
  }

  const pnl = calculateRealizedPnl(
    trade.direction as "buy" | "sell",
    trade.entryFillPrice || trade.entryPrice,
    exitPrice,
    trade.quantity,
  );
  const tradeResult = classifyResult(pnl);
  const feeApplies = trade.tradeOrigin === "copy" && tradeResult === "profit";
  const split = feeApplies ? profitSplit(pnl.toFixed(6)) : profitSplit("0");
  const platformFee = Number(split.platformFee);
  const platformShare = Number(split.platformShare);
  const proTraderShare = Number(split.proTraderShare);
  const feeStatus = feeApplies ? "pending" : "waived";

  const closed = await mongoose.connection.transaction(async session => {
    const result = await Trade.findOneAndUpdate(
      { _id: tradeId, status: { $ne: "closed" } },
      {
        $set: {
          status: "closed",
          exitPrice,
          closedVia,
          closedAt: new Date(),
          realizedPnl: pnl.toFixed(6),
          platformFee: platformFee.toFixed(6),
          platformShare: platformShare.toFixed(6),
          proTraderShare: proTraderShare.toFixed(6),
          feeStatus,
          settlementInvoicePending: feeApplies,
          settlementInvoiceRetryAt: feeApplies ? new Date() : null,
          proTraderCreditStatus: feeApplies ? "pending" : "waived",
          tradeResult,
          wsMonitoringActive: false,
          monitoringStatus: "disconnected",
          monitoringError: null,
        },
      },
      { new: true, session },
    ).lean();
    if (result && feeApplies) {
      const units = usdtUnits(split.platformFee);
      const updated = await User.updateOne({ _id: result.userId, settlementOwedUnits: { $lte: Number.MAX_SAFE_INTEGER - units } },
        { $inc: { settlementOwedUnits: units } }, { session });
      if (updated.matchedCount !== 1) throw new Error("Settlement balance unavailable.");
    }
    return result;
  });

  if (!closed) {
    const current = await Trade.findById(tradeId).lean();
    if (!current) throw new Error(`[profitSharingService] Trade ${tradeId} disappeared.`);
    return {
      tradeId,
      realizedPnl: current.realizedPnl || "0",
      platformFee: current.platformFee || "0",
      feeStatus: (current.feeStatus as TradeCloseResult["feeStatus"]) || "waived",
      tradeResult: current.tradeResult || "breakeven",
    };
  }

  queueTradeEmail(closed.userId, "closed", {
    pair: closed.pair,
    direction: closed.direction,
    quantity: closed.quantity,
    entryPrice: closed.entryFillPrice || closed.entryPrice,
    exitPrice: closed.exitPrice ?? null,
    realizedPnl: closed.realizedPnl ?? null,
    tradeResult: closed.tradeResult ?? null,
  });

  if (feeApplies) {
    // The trade's pending marker survives a crash or unavailable invoice dependency.
    const { retrySettlementForUser } = await import("./settlementPaymentService.js");
    await retrySettlementForUser(closed.userId).catch((error: unknown) => console.error(
      "[Settlement] Invoice task unavailable", String(closed.userId),
      error instanceof Error ? error.message : "Unknown error",
    ));
  }
  return {
    tradeId,
    realizedPnl: pnl.toFixed(6),
    platformFee: platformFee.toFixed(6),
    feeStatus,
    tradeResult,
  };
}

export interface ProfitShareSummary {
  pendingAmount: string;
  threshold: string;
  withdrawalRequired: boolean;
  processing: boolean;
  settlementRequired: boolean;
}

async function restoreLegacySettlementBalance(userId: mongoose.Types.ObjectId) {
  // Schema defaults do not backfill stored documents or apply to lean reads.
  // Recover only absent fields; never replace an existing (even invalid) balance.
  await mongoose.connection.transaction(async session => {
    const legacy = await User.exists({ _id: userId, settlementOwedUnits: { $exists: false } }).session(session);
    if (!legacy) return;
    const unpaid = await Trade.find({
      userId, tradeOrigin: "copy", tradeResult: "profit",
      feeStatus: { $in: ["pending", "processing", "failed"] },
    }).select("platformFee").session(session).lean();
    const units = unpaid.reduce((sum, trade) => sum + usdtUnits(trade.platformFee || "0"), 0);
    if (!Number.isSafeInteger(units)) throw new Error("Settlement amount exceeds supported precision.");
    await User.updateOne({ _id: userId, settlementOwedUnits: { $exists: false } },
      { $set: { settlementOwedUnits: units } }, { session });
  });
}

export async function getProfitShareSummary(
  userId: mongoose.Types.ObjectId,
): Promise<ProfitShareSummary> {
  let user = await User.findById(userId).select("settlementOwedUnits").lean();
  if (user && user.settlementOwedUnits === undefined) {
    await restoreLegacySettlementBalance(userId);
    user = await User.findById(userId).select("settlementOwedUnits").lean();
  }
  const processing = await Trade.exists({ userId, tradeOrigin: "copy", feeStatus: "processing" });
  if (!user || !Number.isSafeInteger(user.settlementOwedUnits) || user.settlementOwedUnits < 0) {
    throw new Error("Settlement balance unavailable.");
  }
  const required = user.settlementOwedUnits >= PROFIT_SHARE_WITHDRAWAL_THRESHOLD * 1_000_000;
  return {
    pendingAmount: formatUsdt(user.settlementOwedUnits),
    threshold: PROFIT_SHARE_WITHDRAWAL_THRESHOLD.toFixed(2),
    withdrawalRequired: required || Boolean(processing),
    settlementRequired: required || Boolean(processing),
    processing: Boolean(processing),
  };
}

export async function resumePendingProfitCredits(): Promise<void> {
  const trades = await Trade.find({ tradeOrigin: "copy", feeStatus: "collected", proTraderCreditStatus: "pending" }).select("_id").limit(100).lean();
  for (const trade of trades) await creditProEarning(trade._id).catch(() => console.error("[Settlement] Pro credit requires retry", String(trade._id)));
}
