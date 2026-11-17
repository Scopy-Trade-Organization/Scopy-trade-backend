import { Transaction } from "../models/transactionModel.js";
import { creditProEarning } from "./proFinanceService.js";
import { profitSplit } from "../helpers/usdt.js";
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

  const closed = await Trade.findOneAndUpdate(
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
        proTraderCreditStatus: feeApplies ? "pending" : "waived",
        tradeResult,
        wsMonitoringActive: false,
        monitoringStatus: "disconnected",
        monitoringError: null,
      },
    },
    { new: true },
  ).lean();

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
    // Notification failures cannot undo a closed trade. The settlement worker retries.
    const { ensureSettlement } = await import("./settlementPaymentService.js");
    await ensureSettlement(closed.userId).catch(() => console.error("[Settlement] Invoice creation requires retry"));
  }
  return {
    tradeId,
    realizedPnl: pnl.toFixed(6),
    platformFee: platformFee.toFixed(6),
    feeStatus,
    tradeResult,
  };
}

const OUTSTANDING_FEE_STATUSES = ["pending", "failed", "processing"] as const;

export interface ProfitShareSummary {
  pendingAmount: string;
  threshold: string;
  withdrawalRequired: boolean;
  processing: boolean;
  settlementRequired: boolean;
}

export async function getProfitShareSummary(
  userId: mongoose.Types.ObjectId,
): Promise<ProfitShareSummary> {
  const [totals] = await Trade.aggregate<{ amount: number; processing: number }>([
    {
      $match: {
        userId,
        tradeOrigin: "copy",
        tradeResult: "profit",
        feeStatus: { $in: [...OUTSTANDING_FEE_STATUSES] },
      },
    },
    {
      $group: {
        _id: null,
        amount: {
          $sum: {
            $convert: { input: "$platformFee", to: "double", onError: 0, onNull: 0 },
          },
        },
        processing: {
          $sum: { $cond: [{ $eq: ["$feeStatus", "processing"] }, 1, 0] },
        },
      },
    },
  ]);
  const amount = totals?.amount ?? 0;
  return {
    pendingAmount: amount.toFixed(6),
    threshold: PROFIT_SHARE_WITHDRAWAL_THRESHOLD.toFixed(2),
    withdrawalRequired: amount + 1e-9 >= PROFIT_SHARE_WITHDRAWAL_THRESHOLD,
    settlementRequired: amount + 1e-9 >= PROFIT_SHARE_WITHDRAWAL_THRESHOLD,
    processing: (totals?.processing ?? 0) > 0,
  };
}

export async function resumePendingProfitCredits(): Promise<void> {
  const completed = await Transaction.find({ type: "settlement", status: "COMPLETED" }).lean();
  for (const settlement of completed) {
    await Trade.updateMany({ settlementBatchId: String(settlement._id), feeStatus: "processing" }, { $set: {
      feeStatus: "collected", settlementTransactionId: settlement.transactionId,
      settlementBlockchainTransactionId: settlement.transactionId,
      settlementNetwork: "TRON", settlementAddress: settlement.address,
      settlementCompletedAt: settlement.completedAt, settlementError: null,
    } });
  }
  const trades = await Trade.find({ tradeOrigin: "copy", feeStatus: "collected", proTraderCreditStatus: "pending" }).select("_id").limit(100).lean();
  for (const trade of trades) await creditProEarning(trade._id).catch(() => console.error("[Settlement] Pro credit requires retry", String(trade._id)));
}
