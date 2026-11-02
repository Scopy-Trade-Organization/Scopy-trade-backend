import { executeTrade } from "../services/tradeExecutionService.js";
import { triggerAutomaticCopies } from "../services/automaticCopyService.js";
import { Request, Response } from "express";
import mongoose from "mongoose";
import { Signal } from "../models/signalModel.js";
import { Trade } from "../models/tradeModel.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import {
  getExchangeBalance,
  getCurrentPrice,
} from "../services/tradeService.js";
import { ExchangeId } from "../types/index.js";
import { decryptCredentials } from "../services/exchangeConnectionService.js";
import { getTradeMonitorService } from "../services/tradeMonitorService.js";
import {
  getExchangeMode,
  shouldRebaseTestnetSignals,
} from "../services/exchangeEnvironment.js";
import {
  SUPPORTED_PAIRS,
  SUPPORTED_TRADE_EXCHANGES,
  MAX_RISK_PERCENT,
  DEFAULT_MAX_ENTRY_DEVIATION,
} from "../constants.js";
import { withCurrentMarketPrices } from "../services/tradeMarketPriceService.js";
import { getProfitShareSummary } from "../services/profitSharingService.js";

// ─── Fetch Exchange Balances ──────────────────────────────────────────────────
export async function fetchExchangeBalances(req: Request, res: Response) {
  try {
    const userId = req.user as mongoose.Types.ObjectId;
    console.info("[fetchExchangeBalances] request", {
      userId: String(userId),
    });

    const connections = await ExchangeConnection.find({
      userId,
      isActive: true,
    }).lean();

    if (!connections.length) {
      const response = {
        success: true,
        balances: [],
        message: "No active exchange connections found.",
      };
      console.info("[fetchExchangeBalances] response", response);
      return res.status(200).json(response);
    }

    // Fan out to all exchanges concurrently; settle independently
    const results = await Promise.allSettled(
      connections.map(async (connection) => {
        console.log("[fetchExchangeBalances] testing exchange", {
          connectionId: String(connection._id),
          exchange: connection.exchange,
        });

        const storedCreds = {
          exchange: connection.exchange as ExchangeId,
          apiKey: connection.encryptedApiKey!,
          apiSecret: connection.encryptedApiSecret!,
          ...(connection.encryptedPassphrase
            ? { passphrase: connection.encryptedPassphrase }
            : {}),
        };

        const rawCreds = decryptCredentials(storedCreds);
        const balanceData = await getExchangeBalance(
          connection.exchange as ExchangeId,
          rawCreds,
        );

        return {
          connectionId: String(connection._id),
          exchange: connection.exchange,
          label: connection.label ?? "",
          status: "ok" as const,
          totalUsdtEquivalent: balanceData.totalUsdtEquivalent,
          balances: balanceData.balances,
        };
      }),
    );

    const balances = results.map((result, i) => {
      const connection = connections[i]!;

      if (result.status === "fulfilled") {
        return result.value;
      }

      // Rejected: surface a sanitized error — never leak raw credential data
      const errMsg =
        result.reason instanceof Error
          ? result.reason.message
          : "Balance fetch failed.";

      const reason = result.reason as any;

      console.error(`[${connection.exchange}] failed for ${connection._id}`, {
        message: reason?.message,
        exchange: reason?.exchange,
        raw: reason,
      });

      return {
        connectionId: String(connection._id),
        exchange: connection.exchange,
        label: connection.label ?? "",
        status: "error" as const,
        totalUsdtEquivalent: null,
        balances: [],
        error: errMsg,
      };
    });

    const response = { success: true, balances };
    console.info("[fetchExchangeBalances] response", response);
    return res.status(200).json(response);
  } catch (err) {
    console.error("[fetchExchangeBalances]", err);
    const response = { message: "Internal server error." };
    console.error("[fetchExchangeBalances] response", response);
    return res.status(500).json(response);
  }
}

// ─── Initiate Trade ───────────────────────────────────────────────────────────
export async function initiateTrade(req: Request, res: Response) {
  const isProTrade = res.locals.tradeOrigin === "pro";
  const result = await executeTrade(req.user as mongoose.Types.ObjectId, req.body, isProTrade);
  if (isProTrade && result.status === 201) {
    triggerAutomaticCopies(String(result.body.trade._id));
  }
  return res.status(result.status).json(result.body);
}

// ─── List User Trades ─────────────────────────────────────────────────────────

/**
 * GET /trades
 * Query params: status (pending|filled|closed|cancelled|failed), page, limit
 */
export async function getUserTrades(req: Request, res: Response) {
  try {
    const userId = req.user as mongoose.Types.ObjectId;
    const { status, page = "1", limit = "20" } = req.query;

    const filter: Record<string, unknown> = { userId };
    if (status === "active") filter.status = { $in: ["pending", "filled"] };
    else if (status === "history") filter.status = { $in: ["closed", "cancelled", "failed"] };
    else if (status) filter.status = status;

    const pageNum = Math.max(1, parseInt(String(page), 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10)));
    const skip = (pageNum - 1) * limitNum;

    const [trades, total] = await Promise.all([
      Trade.find(filter)
        .populate("signalId", "pair direction entry tp sl trader")
        .populate("exchangeConnectionId", "exchange label")
        .populate({
          path: "sourceTradeId",
          select: "userId pair",
          populate: { path: "userId", select: "firstName lastName traderID profilePhoto" },
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Trade.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      trades: await withCurrentMarketPrices(trades),
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error("[getUserTrades]", err);
    return res.status(500).json({ message: "Failed to fetch trades." });
  }
}

/**
 * GET /trades/:tradeId
 */
export async function getTradeById(req: Request, res: Response) {
  try {
    const userId = req.user as mongoose.Types.ObjectId;
    const { tradeId } = req.params;

    if (!mongoose.isValidObjectId(tradeId)) {
      return res.status(400).json({ message: "Invalid trade ID." });
    }

    const trade = await Trade.findOne({ _id: tradeId, userId })
      .populate("signalId", "pair direction entry tp sl notes trader")
      .populate("exchangeConnectionId", "exchange label")
      .lean();

    if (!trade) {
      return res.status(404).json({ message: "Trade not found." });
    }

    let copyStats = null;
    if (trade.tradeOrigin === "pro") {
      const [stats] = await Trade.aggregate([
        { $match: { tradeOrigin: "copy", sourceTradeId: trade._id } },
        {
          $group: {
            _id: "$sourceTradeId",
            total: { $sum: 1 },
            active: { $sum: { $cond: [{ $in: ["$status", ["pending", "filled"]] }, 1, 0] } },
            profitable: { $sum: { $cond: [{ $eq: ["$tradeResult", "profit"] }, 1, 0] } },
          },
        },
      ]);
      copyStats = stats ?? { total: 0, active: 0, profitable: 0 };
    }
    const [pricedTrade] = await withCurrentMarketPrices([{ ...trade, copyStats }]);
    return res.status(200).json({ success: true, trade: pricedTrade });
  } catch (err) {
    console.error("[getTradeById]", err);
    return res.status(500).json({ message: "Failed to fetch trade." });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Heuristically determines a trade result by comparing the actual fill price
 * against the TP and SL targets from the signal.
 *
 * A production system would compare against the actual OCO arm that was
 * triggered. This is a reasonable approximation when only the fill price
 * is available from the status endpoint.
 */
function resolveTradeResult(
  direction: "buy" | "sell",
  entryPrice: string,
  filledPrice: string | null,
  tp: string,
  sl: string,
): "profit" | "loss" | "breakeven" | null {
  if (!filledPrice) return null;

  const exit = parseFloat(filledPrice);
  const entry = parseFloat(entryPrice);
  const tpNum = parseFloat(tp);
  const slNum = parseFloat(sl);

  if (isNaN(exit) || isNaN(entry)) return null;

  const diff = direction === "buy" ? exit - entry : entry - exit;

  // Breakeven band: within 0.05% of entry
  const band = entry * 0.0005;
  if (Math.abs(diff) <= band) return "breakeven";

  // Check proximity to TP vs SL
  const distToTp = Math.abs(exit - tpNum);
  const distToSl = Math.abs(exit - slNum);

  if (distToTp < distToSl) return "profit";
  if (distToSl < distToTp) return "loss";

  return diff > 0 ? "profit" : "loss";
}

// ─── Preview Trade (No Order Placed) ──────────────────────────────────────────

/**
 * POST /trades/preview
 * Calculates position sizing and risk metrics for a signal WITHOUT placing an order.
 * Returns the preview so the frontend can display lot size, risk, and reward before user confirms.
 */
export async function previewTrade(req: Request, res: Response) {
  try {
    const userId = req.user as mongoose.Types.ObjectId;
    const { sourceTradeId, exchangeConnectionId, balance } = req.body;

    // ── 1. Input validation ──────────────────────────────────────────────────
    if (!sourceTradeId || !exchangeConnectionId || !balance) {
      return res.status(400).json({
        success: false,
        message: "sourceTradeId, exchangeConnectionId, and balance are required.",
      });
    }

    if (
      !mongoose.isValidObjectId(sourceTradeId) ||
      !mongoose.isValidObjectId(exchangeConnectionId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid ID format.",
      });
    }

    const parsedBalance = parseFloat(balance);
    if (isNaN(parsedBalance) || parsedBalance <= 0) {
      return res.status(400).json({
        success: false,
        message: "balance must be a positive number.",
      });
    }

    // ── 2. Fetch & validate signal ───────────────────────────────────────────
    const sourceTrade = await Trade.findOne({
      _id: sourceTradeId,
      tradeOrigin: "pro",
      status: { $in: ["pending", "filled"] },
    }).lean();
    if (!sourceTrade) {
      return res.status(404).json({
        success: false,
        message: "Active pro trade not found.",
      });
    }

    const template = await Signal.findById(sourceTrade.signalId).lean();
    const signal = template
      ? {
          ...template,
          pair: sourceTrade.pair,
          direction: sourceTrade.direction,
          entry: sourceTrade.entryFillPrice ?? sourceTrade.entryPrice,
          tp: sourceTrade.tp,
          sl: sourceTrade.sl,
        }
      : null;
    if (!signal) {
      return res.status(404).json({ success: false, message: "Signal not found." });
    }
    if (signal.status !== "active") {
      return res.status(409).json({
        success: false,
        message: "This signal is no longer active.",
      });
    }

    // Pair validation
    const normalizedPair = signal.pair.toUpperCase().replace(/[/-]/g, "");
    if (!SUPPORTED_PAIRS.includes(normalizedPair as any)) {
      return res.status(422).json({
        success: false,
        message: `Trading pair "${signal.pair}" is not currently supported. Supported: ${SUPPORTED_PAIRS.join(", ")}`,
      });
    }

    // ── 3. Fetch & validate connection ───────────────────────────────────────
    const connection = await ExchangeConnection.findOne({
      _id: exchangeConnectionId,
      userId,
      isActive: true,
    }).lean();

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: "Exchange connection not found.",
      });
    }

    if (!SUPPORTED_TRADE_EXCHANGES.includes(connection.exchange as ExchangeId)) {
      return res.status(422).json({
        success: false,
        message: `Exchange "${connection.exchange}" is not supported for trading.`,
      });
    }

    // ── 4. Fetch current market price ────────────────────────────────────────
    const storedCreds = {
      exchange: connection.exchange as ExchangeId,
      apiKey: connection.encryptedApiKey!,
      apiSecret: connection.encryptedApiSecret!,
      ...(connection.encryptedPassphrase
        ? { passphrase: connection.encryptedPassphrase }
        : {}),
    };
    const rawCreds = decryptCredentials(storedCreds);

    let currentPriceResult;
    try {
      currentPriceResult = await getCurrentPrice(
        connection.exchange as ExchangeId,
        signal.pair,
      );
    } catch (priceErr) {
      const message =
        priceErr instanceof Error
          ? priceErr.message
          : "Current price lookup failed.";
      return res.status(502).json({
        success: false,
        message: "Failed to fetch current market price.",
        detail: message,
      });
    }

    // ── 5. Calculate 2% risk position sizing ─────────────────────────────────
    const entryPrice = parseFloat(signal.entry);
    const currentPrice = parseFloat(currentPriceResult.price);

    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return res.status(422).json({
        success: false,
        message: "Signal entry price is invalid.",
      });
    }

    const previewRebased = shouldRebaseTestnetSignals();
    const previewScale = previewRebased ? currentPrice / entryPrice : 1;
    const previewEntry = previewRebased ? currentPrice : entryPrice;
    const slPrice = parseFloat(signal.sl) * previewScale;
    const tpPrice = parseFloat(signal.tp) * previewScale;
    const priceDistance = Math.abs(previewEntry - slPrice);
    if (!Number.isFinite(priceDistance) || priceDistance <= 0) {
      return res.status(422).json({
        success: false,
        message: "Cannot calculate position size: entry and stop-loss prices are too close or identical.",
      });
    }

    const riskAmount = parsedBalance * MAX_RISK_PERCENT;
    const calculatedLotSize = parseFloat((riskAmount / priceDistance).toFixed(6));

    if (!Number.isFinite(calculatedLotSize) || calculatedLotSize <= 0) {
      return res.status(422).json({
        success: false,
        message: "Calculated lot size is invalid.",
      });
    }

    // Risk/reward calculations
    const distanceToTP = Math.abs(tpPrice - previewEntry);
    const estimatedLossIfSL = priceDistance * calculatedLotSize;
    const estimatedProfitIfTP = distanceToTP * calculatedLotSize;
    const riskRewardRatio =
      priceDistance > 0 ? parseFloat((distanceToTP / priceDistance).toFixed(2)) : 0;

    // Deviation check (informational — not blocking in preview)
    const deviation = Math.abs(currentPrice - entryPrice) / entryPrice;

    return res.status(200).json({
      success: true,
      preview: {
        pair: signal.pair,
        direction: signal.direction,
        exchange: connection.exchange,
        entryPrice: String(previewEntry),
        stopLoss: String(slPrice),
        takeProfit: String(tpPrice),
        originalSignalPrices: previewRebased
          ? { entry: signal.entry, stopLoss: signal.sl, takeProfit: signal.tp }
          : null,
        signalPricesRebased: previewRebased,
        exchangeMode: getExchangeMode(),
        currentMarketPrice: currentPriceResult.price,
        balance: String(parsedBalance),
        riskPercent: MAX_RISK_PERCENT,
        riskAmount: riskAmount.toFixed(2),
        priceDistance: priceDistance.toFixed(2),
        calculatedLotSize: String(calculatedLotSize),
        estimatedLossIfSL: estimatedLossIfSL.toFixed(2),
        estimatedProfitIfTP: estimatedProfitIfTP.toFixed(2),
        riskRewardRatio: String(riskRewardRatio),
        deviation: Number(deviation.toFixed(6)),
        maxDeviation: DEFAULT_MAX_ENTRY_DEVIATION,
        deviationWarning:
          !previewRebased && deviation > DEFAULT_MAX_ENTRY_DEVIATION,
      },
    });
  } catch (err) {
    console.error("[previewTrade]", err);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
}
