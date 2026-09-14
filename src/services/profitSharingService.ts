import mongoose from "mongoose";
import { Trade } from "../models/tradeModel.js";
import User from "../models/userModel.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import {
  PLATFORM_FEE_PERCENT,
  PLATFORM_SHARE_PERCENT,
  PROFIT_SHARE_WITHDRAWAL_THRESHOLD,
  PRO_TRADER_SHARE_PERCENT,
} from "../constants.js";
import { decryptCredentials } from "./exchangeConnectionService.js";
import { withdrawUsdt, getSystemWallet } from "./withdrawalService.js";
import { ExchangeId } from "../types/index.js";
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
 * user explicitly approves a withdrawal.
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
  const platformFee = feeApplies ? pnl * PLATFORM_FEE_PERCENT : 0;
  const platformShare = feeApplies ? pnl * PLATFORM_SHARE_PERCENT : 0;
  const proTraderShare = feeApplies ? pnl * PRO_TRADER_SHARE_PERCENT : 0;
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
    processing: (totals?.processing ?? 0) > 0,
  };
}

async function creditProTraderShare(trade: {
  _id: mongoose.Types.ObjectId;
  sourceTradeId?: mongoose.Types.ObjectId | null;
  proTraderShare?: string | null;
}): Promise<void> {
  const source = trade.sourceTradeId
    ? await Trade.findById(trade.sourceTradeId).select("userId").lean()
    : null;
  if (!source) return;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const claimed = await Trade.updateOne(
        { _id: trade._id, feeStatus: "collected", proTraderCreditStatus: "pending" },
        { $set: { proTraderCreditStatus: "credited", proTraderCreditedAt: new Date() } },
        { session },
      );
      if (claimed.modifiedCount === 1) {
        await User.updateOne(
          { _id: source.userId },
          { $inc: { proEarningsBalance: Number(trade.proTraderShare || 0) } },
          { session },
        );
      }
    });
  } finally {
    await session.endSession();
  }
}

/** Collects all currently accrued fees after explicit copy-trader approval. */
export async function approveProfitShareWithdrawal(
  userId: mongoose.Types.ObjectId,
  exchangeConnectionId: string,
): Promise<{ amount: string; transactionId: string }> {
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
  const lockedUser = await User.findOneAndUpdate(
    {
      _id: userId,
      $or: [
        { profitShareWithdrawalStatus: { $ne: "processing" } },
        { profitShareWithdrawalStartedAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: {
        profitShareWithdrawalStatus: "processing",
        profitShareWithdrawalStartedAt: new Date(),
      },
    },
    { new: true },
  ).lean();
  if (!lockedUser) throw new Error("A profit-share withdrawal is already processing.");

  let batchId: string | null = null;
  let claimedIds: mongoose.Types.ObjectId[] = [];
  try {
    const retryableBatch = await Trade.findOne({
      userId,
      tradeOrigin: "copy",
      tradeResult: "profit",
      feeStatus: "failed",
      settlementBatchId: { $ne: null },
    }).select("settlementBatchId").sort({ settlementStartedAt: 1 }).lean();

    batchId = retryableBatch?.settlementBatchId || new mongoose.Types.ObjectId().toString();
    const pending = await Trade.find(
      retryableBatch?.settlementBatchId
        ? {
            userId,
            tradeOrigin: "copy",
            tradeResult: "profit",
            feeStatus: "failed",
            settlementBatchId: retryableBatch.settlementBatchId,
          }
        : {
            userId,
            tradeOrigin: "copy",
            tradeResult: "profit",
            feeStatus: { $in: ["pending", "failed"] },
            $or: [{ settlementBatchId: null }, { settlementBatchId: { $exists: false } }],
          },
    )
      .select("_id platformFee sourceTradeId proTraderShare")
      .sort({ closedAt: 1 })
      .lean();
    const amount = pending.reduce((sum, trade) => sum + Number(trade.platformFee || 0), 0);
    if (amount + 1e-9 < PROFIT_SHARE_WITHDRAWAL_THRESHOLD) {
      throw new Error(
        `Profit share must reach ${PROFIT_SHARE_WITHDRAWAL_THRESHOLD.toFixed(2)} USDT before withdrawal.`,
      );
    }

    claimedIds = pending.map((trade) => trade._id);
    const connection = await ExchangeConnection.findOne({
      _id: exchangeConnectionId,
      userId,
      isActive: true,
    }).lean();
    if (!connection?.encryptedApiKey || !connection.encryptedApiSecret) {
      throw new Error("Select a valid active exchange connection.");
    }

    await Trade.updateMany(
      { _id: { $in: claimedIds }, feeStatus: { $in: ["pending", "failed"] } },
      {
        $set: {
          feeStatus: "processing",
          settlementBatchId: batchId,
          settlementStartedAt: new Date(),
          settlementError: null,
        },
      },
    );

    const credentials = decryptCredentials({
      exchange: connection.exchange as ExchangeId,
      apiKey: connection.encryptedApiKey,
      apiSecret: connection.encryptedApiSecret,
      ...(connection.encryptedPassphrase
        ? { passphrase: connection.encryptedPassphrase }
        : {}),
    });
    const wallet = getSystemWallet();
    const withdrawal = await withdrawUsdt(
      connection.exchange as ExchangeId,
      credentials,
      amount.toFixed(6),
      wallet.address,
      wallet.network,
      `profit-share-${batchId}`,
    );

    await Trade.updateMany(
      { settlementBatchId: batchId, feeStatus: "processing" },
      {
        $set: {
          feeStatus: "collected",
          settlementNetwork: wallet.network,
          settlementAddress: wallet.address,
          settlementTransactionId: withdrawal.transactionId,
          settlementBlockchainTransactionId: withdrawal.blockchainTransactionId || null,
          settlementCompletedAt: new Date(),
          settlementError: null,
        },
      },
    );

    for (const trade of pending) {
      await creditProTraderShare(trade).catch((error) =>
        console.error(`[profitSharingService] Pro credit failed for ${trade._id}:`, error),
      );
    }
    return { amount: amount.toFixed(6), transactionId: withdrawal.transactionId };
  } catch (error) {
    if (claimedIds.length && batchId) {
      await Trade.updateMany(
        { settlementBatchId: batchId, feeStatus: "processing" },
        {
          $set: {
            feeStatus: "failed",
            settlementError: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
    throw error;
  } finally {
    await User.updateOne(
      { _id: userId },
      { $set: { profitShareWithdrawalStatus: "idle", profitShareWithdrawalStartedAt: null } },
    );
  }
}

/** Startup recovery credits pros only; withdrawals always require user approval. */
export async function resumePendingProfitCredits(): Promise<void> {
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
  await Promise.all([
    Trade.updateMany(
      {
        tradeOrigin: "copy",
        tradeResult: "profit",
        feeStatus: "processing",
        settlementBatchId: { $ne: null },
        settlementStartedAt: { $lt: staleBefore },
      },
      {
        $set: {
          feeStatus: "failed",
          settlementError: "A previous approved withdrawal was interrupted. Please approve it again.",
        },
      },
    ),
    User.updateMany(
      {
        role: "CopyTrader",
        profitShareWithdrawalStatus: "processing",
        profitShareWithdrawalStartedAt: { $lt: staleBefore },
      },
      { $set: { profitShareWithdrawalStatus: "idle", profitShareWithdrawalStartedAt: null } },
    ),
  ]);

  const trades = await Trade.find({
    tradeOrigin: "copy",
    feeStatus: "collected",
    proTraderCreditStatus: "pending",
  })
    .select("_id sourceTradeId proTraderShare")
    .limit(100)
    .lean();
  for (const trade of trades) {
    await creditProTraderShare(trade).catch((error) =>
      console.error(`[profitSharingService] Pro credit recovery failed for ${trade._id}:`, error),
    );
  }
}
