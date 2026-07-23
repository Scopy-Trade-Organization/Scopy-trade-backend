import { Request, Response } from "express";
import mongoose from "mongoose";
import { Signal } from "../models/signalModel.js";
import { Trade } from "../models/tradeModel.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import {
  placeOrder,
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

    const response = { balances };
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
  try {
    const userId = req.user as mongoose.Types.ObjectId;
    const { signalId, exchangeConnectionId, balance } = req.body;

    // ── 1. Input validation ──────────────────────────────────────────────────
    if (!signalId || !exchangeConnectionId || !balance) {
      return res.status(400).json({
        success: true,
        message: "signalId, exchangeConnectionId, and balance are required.",
      });
    }

    if (
      !mongoose.isValidObjectId(signalId) ||
      !mongoose.isValidObjectId(exchangeConnectionId)
    ) {
      return res.status(400).json({
        success: true,
        message: "Invalid ID format.",
      });
    }

    const parsedBalance = parseFloat(balance);
    if (isNaN(parsedBalance) || parsedBalance <= 0) {
      return res.status(400).json({
        success: true,
        message: "balance must be a positive number.",
      });
    }

    // ── 2. Fetch & validate the signal ───────────────────────────────────────
    const signal = await Signal.findById(signalId).lean();
    if (!signal) {
      return res.status(404).json({
        success: true,
        message: "Signal not found.",
      });
    }
    if (signal.status !== "active") {
      return res.status(409).json({
        success: true,
        message: "This signal is no longer active and cannot be copied.",
      });
    }

    // ── 2b. Validate trading pair is supported ───────────────────────────────
    const normalizedPair = signal.pair.toUpperCase().replace(/\//g, "");
    if (!SUPPORTED_PAIRS.includes(normalizedPair as any)) {
      return res.status(422).json({
        success: false,
        message: `Trading pair "${signal.pair}" is not currently supported. Supported pairs: ${SUPPORTED_PAIRS.join(", ")}`,
      });
    }

    // ── 3. Fetch & validate the exchange connection ──────────────────────────
    const connection = await ExchangeConnection.findOne({
      _id: exchangeConnectionId,
      userId,
      isActive: true,
    }).lean();

    if (!connection) {
      return res.status(404).json({
        success: true,
        message:
          "Exchange connection not found or does not belong to your account.",
      });
    }

    // ── 3b. Validate exchange is supported for trading ───────────────────────
    if (!SUPPORTED_TRADE_EXCHANGES.includes(connection.exchange as ExchangeId)) {
      return res.status(422).json({
        success: false,
        message: `Exchange "${connection.exchange}" is not currently supported for trading. Supported: ${SUPPORTED_TRADE_EXCHANGES.join(", ")}`,
      });
    }

    // ── 4. Guard against duplicate trade ─────────────────────────────────────
    const existing = await Trade.findOne({
      signalId,
      exchangeConnectionId,
    }).lean();

    if (existing) {
      return res.status(409).json({
        success: true,
        message:
          "You have already initiated a trade for this signal on this exchange.",
        trade: { _id: existing._id, status: existing.status },
      });
    }

    // ── 5. Decrypt credentials ───────────────────────────────────────────────
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
      console.error("[initiateTrade] Price lookup error:", message);
      return res.status(502).json({
        message: "Failed to fetch current market price.",
        detail: message,
      });
    }

    const signalEntryPrice = parseFloat(signal.entry);
    const currentPrice = parseFloat(currentPriceResult.price);

    if (!Number.isFinite(signalEntryPrice) || signalEntryPrice <= 0) {
      return res.status(422).json({
        message: "Signal entry price is invalid.",
      });
    }

    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return res.status(502).json({
        message: "Exchange returned an invalid current price.",
      });
    }

    const configuredMaxDeviation = parseFloat(
      process.env.TRADE_ENTRY_DEVIATION_LIMIT ?? "",
    );
    const maxDeviation =
      Number.isFinite(configuredMaxDeviation) && configuredMaxDeviation > 0
        ? configuredMaxDeviation
        : DEFAULT_MAX_ENTRY_DEVIATION;
    const deviation =
      Math.abs(currentPrice - signalEntryPrice) / signalEntryPrice;
    const rebaseForTestnet = shouldRebaseTestnetSignals();

    if (!rebaseForTestnet && deviation > maxDeviation) {
      return res.status(409).json({
        message: "Current market price is too far from the signal entry price.",
        pair: signal.pair,
        entryPrice: signal.entry,
        currentPrice: currentPriceResult.price,
        deviation: Number(deviation.toFixed(6)),
        maxDeviation,
      });
    }

    // ── 6. Position sizing — 2% risk model ───────────────────────────────────
    const testnetScale = rebaseForTestnet
      ? currentPrice / signalEntryPrice
      : 1;
    const executionEntryPrice = rebaseForTestnet
      ? currentPrice
      : signalEntryPrice;
    const executionTpPrice = parseFloat(signal.tp) * testnetScale;
    const executionSlPrice = parseFloat(signal.sl) * testnetScale;
    const validLevels =
      Number.isFinite(executionTpPrice) &&
      Number.isFinite(executionSlPrice) &&
      executionTpPrice > 0 &&
      executionSlPrice > 0 &&
      (signal.direction === "buy"
        ? executionSlPrice < executionEntryPrice &&
          executionEntryPrice < executionTpPrice
        : executionTpPrice < executionEntryPrice &&
          executionEntryPrice < executionSlPrice);
    if (!validLevels) {
      return res.status(422).json({
        message:
          "Signal price levels are invalid for its direction. A long requires SL < entry < TP; a short requires TP < entry < SL.",
      });
    }
    const priceDistance = Math.abs(executionEntryPrice - executionSlPrice);

    if (!Number.isFinite(priceDistance) || priceDistance <= 0) {
      return res.status(422).json({
        message:
          "Cannot calculate position size: entry and stop-loss prices are too close or identical.",
      });
    }

    const riskAmount = parsedBalance * MAX_RISK_PERCENT;
    const quantity = riskAmount / priceDistance;
    const parsedQty = parseFloat(quantity.toFixed(6));

    if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
      return res.status(422).json({
        message: "Calculated order quantity is invalid.",
      });
    }

    // ── 6. Place the order on the exchange ───────────────────────────────────
    let placed;
    try {
      placed = await placeOrder(connection.exchange as ExchangeId, {
        credentials: rawCreds,
        pair: signal.pair,
        direction: signal.direction as "buy" | "sell",
        quantity: String(parsedQty),
        entryPrice: String(executionEntryPrice),
        tp: String(executionTpPrice),
        sl: String(executionSlPrice),
      });
    } catch (orderErr) {
      const message =
        orderErr instanceof Error
          ? orderErr.message
          : "Order placement failed.";
      console.error("[initiateTrade] Exchange error:", message);
      return res.status(502).json({
        message: "Failed to place order on exchange.",
        detail: message,
      });
    }

    // ── 7. Persist trade record ──────────────────────────────────────────────
    const trade = await Trade.create({
      userId,
      pair: signal.pair,
      direction: signal.direction,
      tp: placed.execution?.tp ?? String(executionTpPrice),
      sl: placed.execution?.sl ?? String(executionSlPrice),
      signalId,
      exchangeConnectionId,
      exchangeOrderId: placed.orderId,
      quantity: placed.execution?.quantity ?? String(parsedQty),
      entryPrice:
        placed.execution?.entryPrice ?? String(executionEntryPrice),
      status: "pending",
      wsMonitoringActive: true,
      rawOrderResponse: {
        order: placed.raw,
        marketPrice: currentPriceResult.raw,
        sizing: {
          balance: parsedBalance,
          riskPercent: MAX_RISK_PERCENT,
          riskAmount,
          priceDistance,
          currentPrice: currentPriceResult.price,
          deviation,
          exchangeMode: getExchangeMode(),
          signalPricesRebased: rebaseForTestnet,
          originalSignalPrices: {
            entry: signal.entry,
            tp: signal.tp,
            sl: signal.sl,
          },
        },
      },
    });

    try {
      await getTradeMonitorService().startMonitoring(String(trade._id));
    } catch (monitorErr) {
      await Trade.updateOne(
        { _id: trade._id },
        { $set: { wsMonitoringActive: false } },
      );
      console.error("[initiateTrade] Failed to start trade monitor:", monitorErr);
    }

    return res.status(201).json({
      message: "Trade initiated successfully.",
      trade: {
        _id: trade._id,
        pair: trade.pair,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        tp: trade.tp,
        sl: trade.sl,
        quantity: trade.quantity,
        status: trade.status,
        exchangeOrderId: trade.exchangeOrderId,
        createdAt: trade.createdAt,
      },
    });
  } catch (err) {
    console.error("[initiateTrade]", err);
    return res.status(500).json({ message: "Internal server error." });
  }
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
    if (status) filter.status = status;

    const pageNum = Math.max(1, parseInt(String(page), 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10)));
    const skip = (pageNum - 1) * limitNum;

    const [trades, total] = await Promise.all([
      Trade.find(filter)
        .populate("signalId", "pair direction entry tp sl trader")
        .populate("exchangeConnectionId", "exchange label")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Trade.countDocuments(filter),
    ]);

    return res.status(200).json({
      trades,
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

    return res.status(200).json({ trade });
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
    const { signalId, exchangeConnectionId, balance } = req.body;

    // ── 1. Input validation ──────────────────────────────────────────────────
    if (!signalId || !exchangeConnectionId || !balance) {
      return res.status(400).json({
        success: false,
        message: "signalId, exchangeConnectionId, and balance are required.",
      });
    }

    if (
      !mongoose.isValidObjectId(signalId) ||
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
    const signal = await Signal.findById(signalId).lean();
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
    const normalizedPair = signal.pair.toUpperCase().replace(/\//g, "");
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
