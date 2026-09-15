import { Request, Response } from "express";
import mongoose from "mongoose";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import { Signal } from "../models/signalModel.js";
import { Trade } from "../models/tradeModel.js";
import User from "../models/userModel.js";
import { Settlement } from "../models/settlementModel.js";
import {
  approveProfitShareWithdrawal,
  processTradeClose,
} from "../services/profitSharingService.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DECIMAL_PATTERN = /^\d+(\.\d{1,8})?$/;

function publicTrade(trade: any) {
  return {
    _id: trade._id,
    userId: trade.userId,
    tradeOrigin: trade.tradeOrigin,
    sourceTradeId: trade.sourceTradeId,
    quantity: trade.quantity,
    realizedPnl: trade.realizedPnl,
    platformFee: trade.platformFee,
    platformShare: trade.platformShare,
    proTraderShare: trade.proTraderShare,
    feeStatus: trade.feeStatus,
    tradeResult: trade.tradeResult,
    status: trade.status,
  };
}

async function tradeClosePayload(signalId: mongoose.Types.ObjectId) {
  const trades = await Trade.find({ signalId }).sort({ createdAt: 1 }).lean();
  const proTrade = trades.find((trade) => trade.tradeOrigin === "pro");
  const copies = trades.filter((trade) => trade.tradeOrigin === "copy");
  return {
    proTrade: proTrade ? publicTrade(proTrade) : null,
    copiedTrades: copies.map(publicTrade),
    totals: {
      copiers: copies.length,
      copierRealizedPnl: copies
        .reduce((sum, trade) => sum + Number(trade.realizedPnl || 0), 0)
        .toFixed(6),
      settlementAmount: copies
        .reduce((sum, trade) => sum + Number(trade.platformFee || 0), 0)
        .toFixed(6),
      platformShare: copies
        .reduce((sum, trade) => sum + Number(trade.platformShare || 0), 0)
        .toFixed(6),
      proTraderShare: copies
        .reduce((sum, trade) => sum + Number(trade.proTraderShare || 0), 0)
        .toFixed(6),
    },
  };
}

/** Creates filled records and closes them through the real PnL/fee service. */
export async function simulateSuccessfulTradeClose(
  req: Request,
  res: Response,
) {
  try {
    const proUserId = req.user as mongoose.Types.ObjectId;
    const {
      requestId,
      pair,
      direction,
      entryPrice,
      exitPrice,
      tp,
      sl,
      closedVia = "manual",
      proTrade,
      copiers,
    } = req.body;

    if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
      return res.status(400).json({
        success: false,
        message:
          "requestId must contain 1-64 letters, numbers, underscores, or hyphens.",
      });
    }
    const replay = await Signal.findOne({
      trader: proUserId,
      temporaryRequestId: requestId,
    }).lean();
    if (replay) {
      if (replay.temporarySimulationStatus !== "completed") {
        return res.status(409).json({
          success: false,
          idempotent: true,
          message: `The original simulation request is ${replay.temporarySimulationStatus || "incomplete"}; no duplicate data was created.`,
        });
      }
      return res.status(200).json({
        success: true,
        idempotent: true,
        simulation: await tradeClosePayload(replay._id),
      });
    }
    const normalizedPair = String(pair || "")
      .toUpperCase()
      .replace(/[/-]/g, "");
    if (!/^[A-Z0-9]{5,20}$/.test(normalizedPair)) {
      return res.status(400).json({
        success: false,
        message: "pair must be a valid symbol such as BTCUSDT.",
      });
    }
    if (!["buy", "sell"].includes(direction)) {
      return res
        .status(400)
        .json({ success: false, message: "direction must be buy or sell." });
    }
    const prices = [entryPrice, exitPrice, tp, sl].map((value) =>
      String(value ?? ""),
    );
    if (
      prices.some((value) => !DECIMAL_PATTERN.test(value) || Number(value) <= 0)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "entryPrice, exitPrice, tp, and sl must be positive decimals with at most 8 places.",
      });
    }
    if (!["tp", "sl", "manual"].includes(closedVia)) {
      return res.status(400).json({
        success: false,
        message: "closedVia must be tp, sl, or manual.",
      });
    }
    if (
      !proTrade ||
      !mongoose.isValidObjectId(proTrade.exchangeConnectionId) ||
      !DECIMAL_PATTERN.test(String(proTrade.quantity || "")) ||
      Number(proTrade.quantity) <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "proTrade requires a valid exchangeConnectionId and positive quantity.",
      });
    }
    if (!Array.isArray(copiers) || copiers.length < 1 || copiers.length > 4) {
      return res.status(400).json({
        success: false,
        message: "copiers must contain between one and four entries.",
      });
    }
    if (
      copiers.some(
        (copy: any) =>
          !mongoose.isValidObjectId(copy?.userId) ||
          !mongoose.isValidObjectId(copy?.exchangeConnectionId) ||
          !DECIMAL_PATTERN.test(String(copy?.quantity || "")) ||
          Number(copy.quantity) <= 0,
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Each copier requires valid userId, exchangeConnectionId, and positive quantity.",
      });
    }
    const connectionIds = [
      proTrade.exchangeConnectionId,
      ...copiers.map((copy: any) => copy.exchangeConnectionId),
    ];
    if (new Set(connectionIds.map(String)).size !== connectionIds.length) {
      return res.status(400).json({
        success: false,
        message:
          "Each simulated trade must use a different exchange connection.",
      });
    }

    const [connections, copierUsers] = await Promise.all([
      ExchangeConnection.find({ _id: { $in: connectionIds } })
        .select("_id userId exchange label isActive")
        .lean(),
      User.find({
        _id: { $in: copiers.map((copy: any) => copy.userId) },
        role: "CopyTrader",
      })
        .select("_id")
        .lean(),
    ]);
    const connectionById = new Map(
      connections.map((connection) => [String(connection._id), connection]),
    );
    const copyUserIds = new Set(copierUsers.map((user) => String(user._id)));
    const requestedPairs = [
      {
        traderType: "pro",
        traderId: String(proUserId),
        exchangeConnectionId: String(proTrade.exchangeConnectionId),
        traderHasRequiredRole: true,
      },
      ...copiers.map((copy: any, index: number) => ({
        traderType: `copier-${index + 1}`,
        traderId: String(copy.userId),
        exchangeConnectionId: String(copy.exchangeConnectionId),
        traderHasRequiredRole: copyUserIds.has(String(copy.userId)),
      })),
    ];
    const pairDiagnostics = requestedPairs.map((pair) => {
      const connection = connectionById.get(pair.exchangeConnectionId);
      const actualOwnerId = connection ? String(connection.userId) : null;
      const issues: string[] = [];
      if (!pair.traderHasRequiredRole) issues.push("trader is missing or is not a CopyTrader");
      if (!connection) issues.push("exchange connection does not exist");
      else {
        if (!connection.isActive) issues.push("exchange connection is inactive");
        if (actualOwnerId !== pair.traderId) issues.push("exchange connection belongs to another trader");
      }
      return {
        ...pair,
        connectionFound: Boolean(connection),
        connectionActive: connection?.isActive ?? null,
        exchange: connection?.exchange ?? null,
        connectionLabel: connection?.label ?? null,
        actualOwnerId,
        issues,
        valid: issues.length === 0,
      };
    });
    const invalidPairs = pairDiagnostics.filter((pair) => !pair.valid);
    if (invalidPairs.length > 0) {
      console.error(
        "[temporary trade close] Invalid trader/exchange connection pair(s):",
        invalidPairs,
      );
      return res.status(422).json({
        success: false,
        message:
          "Every exchange connection must be active and owned by its stated trader.",
      });
    }

    const signal = await Signal.create({
      pair: normalizedPair,
      direction,
      entry: String(entryPrice),
      tp: String(tp),
      sl: String(sl),
      trader: proUserId,
      status: "expired",
      temporaryRequestId: requestId,
      temporarySimulationStatus: "processing",
      notes: `Temporary successful-close simulation ${requestId}`,
    });
    const common = {
      pair: normalizedPair,
      direction,
      tp: String(tp),
      sl: String(sl),
      signalId: signal._id,
      entryPrice: String(entryPrice),
      entryFillPrice: String(entryPrice),
      status: "filled" as const,
      monitoringStatus: "disconnected" as const,
      wsMonitoringActive: false,
      rawOrderResponse: { simulated: true, requestId },
    };
    const [createdPro] = await Trade.create([
      {
        ...common,
        userId: proUserId,
        tradeOrigin: "pro",
        sourceTradeId: null,
        exchangeConnectionId: proTrade.exchangeConnectionId,
        exchangeOrderId: `sim-pro-${requestId}`,
        quantity: String(proTrade.quantity),
      },
    ]);
    if (!createdPro)
      throw new Error("Failed to create the simulated pro trade.");
    const createdCopies = await Trade.insertMany(
      copiers.map((copy: any, index: number) => ({
        ...common,
        userId: copy.userId,
        tradeOrigin: "copy",
        sourceTradeId: createdPro._id,
        exchangeConnectionId: copy.exchangeConnectionId,
        exchangeOrderId: `sim-copy-${requestId}-${index + 1}`,
        quantity: String(copy.quantity),
      })),
    );
    await Promise.all([
      processTradeClose(String(createdPro._id), String(exitPrice), closedVia),
      ...createdCopies.map((trade) =>
        processTradeClose(String(trade._id), String(exitPrice), closedVia),
      ),
    ]);
    const pnlDirection =
      direction === "buy"
        ? Number(exitPrice) - Number(entryPrice)
        : Number(entryPrice) - Number(exitPrice);
    signal.signalResult =
      pnlDirection > 0 ? "profit" : pnlDirection < 0 ? "loss" : "breakeven";
    signal.temporarySimulationStatus = "completed";
    await signal.save();
    return res.status(201).json({
      success: true,
      idempotent: false,
      simulation: await tradeClosePayload(signal._id),
    });
  } catch (error: any) {
    if (error?.code === 11000 && req.user && req.body?.requestId) {
      const signal = await Signal.findOne({
        trader: req.user,
        temporaryRequestId: req.body.requestId,
      }).lean();
      if (signal?.temporarySimulationStatus === "completed") {
        return res.status(200).json({
          success: true,
          idempotent: true,
          simulation: await tradeClosePayload(signal._id),
        });
      }
    }
    if (req.user && req.body?.requestId) {
      await Signal.updateOne(
        {
          trader: req.user,
          temporaryRequestId: req.body.requestId,
          temporarySimulationStatus: "processing",
        },
        { $set: { temporarySimulationStatus: "failed" } },
      ).catch(() => undefined);
    }
    console.error("[temporary trade close]", error);
    return res.status(500).json({
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Trade-close simulation failed.",
    });
  }
}

/** Runs real signed credential/balance preflight, then simulates transfer success. */
export async function simulateProfitShareWithdrawal(
  req: Request,
  res: Response,
) {
  try {
    const userId = req.user as mongoose.Types.ObjectId;
    const exchangeConnectionId = String(req.body.exchangeConnectionId || "");
    const requestId = String(req.body.requestId || "");
    if (!mongoose.isValidObjectId(exchangeConnectionId)) {
      return res.status(400).json({
        success: false,
        message: "A valid exchangeConnectionId is required.",
      });
    }
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      return res.status(400).json({
        success: false,
        message:
          "requestId must contain 1-64 letters, numbers, underscores, or hyphens.",
      });
    }
    const result = await approveProfitShareWithdrawal(
      userId,
      exchangeConnectionId,
      { requestId, simulateSuccess: true },
    );
    const settlement = await Settlement.findOne({ userId, requestId })
      .select("-destinationAddress")
      .lean();
    return res.status(200).json({
      success: true,
      idempotent: result.idempotent,
      message:
        "The signed exchange preflight passed and the withdrawal was simulated as completed; no funds moved.",
      settlement,
    });
  } catch (error) {
    console.error("[temporary settlement simulation]", error);
    return res.status(422).json({
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Settlement simulation failed.",
    });
  }
}
