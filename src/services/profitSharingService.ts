import mongoose from "mongoose";
import { Trade } from "../models/tradeModel.js";
import User from "../models/userModel.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import {
  PLATFORM_FEE_PERCENT,
  PLATFORM_SHARE_PERCENT,
  PRO_TRADER_SHARE_PERCENT,
} from "../constants.js";
import { decryptCredentials } from "./exchangeConnectionService.js";
import { withdrawUsdt, getPlatformWallet } from "./withdrawalService.js";
import { ExchangeId } from "../types/index.js";

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
 * Persists the close exactly once, then schedules fee settlement without
 * blocking the exchange-monitor callback.
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

  if (feeApplies) queueProfitSettlement(tradeId);

  return {
    tradeId,
    realizedPnl: pnl.toFixed(6),
    platformFee: platformFee.toFixed(6),
    feeStatus,
    tradeResult,
  };
}

export function queueProfitSettlement(tradeId: string): void {
  setImmediate(() => {
    void settleCopiedTradeProfit(tradeId).catch((error) => {
      console.error(`[profitSharingService] Settlement failed for ${tradeId}:`, error);
    });
  });
}

/** Withdraws the full 20% first, then atomically credits 5% to the source pro. */
export async function settleCopiedTradeProfit(tradeId: string): Promise<void> {
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
  const trade = await Trade.findOneAndUpdate(
    {
      _id: tradeId,
      tradeOrigin: "copy",
      tradeResult: "profit",
      $or: [
        { feeStatus: { $in: ["pending", "failed"] } },
        { feeStatus: "processing", settlementStartedAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: {
        feeStatus: "processing",
        settlementStartedAt: new Date(),
        settlementError: null,
      },
    },
    { new: true },
  ).lean();
  if (!trade) return;

  try {
    const connection = await ExchangeConnection.findById(trade.exchangeConnectionId).lean();
    if (!connection?.encryptedApiKey || !connection.encryptedApiSecret) {
      throw new Error("The copy trader's exchange connection is unavailable.");
    }
    const credentials = decryptCredentials({
      exchange: connection.exchange as ExchangeId,
      apiKey: connection.encryptedApiKey,
      apiSecret: connection.encryptedApiSecret,
      ...(connection.encryptedPassphrase
        ? { passphrase: connection.encryptedPassphrase }
        : {}),
    });
    const wallet = getPlatformWallet();
    const withdrawal = await withdrawUsdt(
      connection.exchange as ExchangeId,
      credentials,
      trade.platformFee || "0",
      wallet.address,
      wallet.network,
      `copy-profit-${tradeId}`,
    );

    await Trade.updateOne(
      { _id: tradeId, feeStatus: "processing" },
      {
        $set: {
          feeStatus: "collected",
          settlementNetwork: wallet.network,
          settlementAddress: wallet.address,
          settlementTransactionId: withdrawal.transactionId,
          settlementCompletedAt: new Date(),
          settlementError: null,
        },
      },
    );

    const source = trade.sourceTradeId
      ? await Trade.findById(trade.sourceTradeId).select("userId").lean()
      : null;
    if (!source) throw new Error("The source pro trade was not found for commission credit.");

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const claimed = await Trade.updateOne(
          { _id: tradeId, proTraderCreditStatus: "pending" },
          {
            $set: {
              proTraderCreditStatus: "credited",
              proTraderCreditedAt: new Date(),
            },
          },
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
  } catch (error) {
    await Trade.updateOne(
      { _id: tradeId, feeStatus: "processing" },
      {
        $set: {
          feeStatus: "failed",
          settlementError: error instanceof Error ? error.message : String(error),
        },
      },
    );
    throw error;
  }
}

export async function resumePendingProfitSettlements(): Promise<void> {
  const trades = await Trade.find({
    tradeOrigin: "copy",
    tradeResult: "profit",
    feeStatus: { $in: ["pending", "failed"] },
  })
    .select("_id")
    .limit(100)
    .lean();
  for (const trade of trades) queueProfitSettlement(String(trade._id));
}
