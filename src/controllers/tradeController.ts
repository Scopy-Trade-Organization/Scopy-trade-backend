import { Request, Response } from "express";
import mongoose from "mongoose";
import { Signal } from "../models/signalModel.js";
import { Trade } from "../models/tradeModel.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import {
  decryptCredentials,
  placeOrder,
  getOrderStatus,
  attachBinanceTpSl,
} from "../services/exchangeService.js";
import { ExchangeId } from "../types/index.js";

// ─── Initiate Trade ───────────────────────────────────────────────────────────

/**
 * POST /trades
 * Body: { signalId, exchangeConnectionId, quantity }
 *
 * Flow:
 *  1. Validate the signal is still active.
 *  2. Verify the exchange connection belongs to the requesting user and is active.
 *  3. Guard against duplicate (same signal + same connection).
 *  4. Decrypt stored credentials.
 *  5. Place the order on the exchange.
 *  6. Persist the trade record with the returned exchange order ID.
 *  7. For Binance, attach the TP/SL OCO order immediately (fire-and-forget with
 *     a logged error — the polling job will catch unresolved trades).
 */
export async function initiateTrade(req: Request, res: Response) {
  try {
    const userId = req.user as mongoose.Types.ObjectId;
    const { signalId, exchangeConnectionId, quantity } = req.body;

    // ── 1. Input validation ──────────────────────────────────────────────────
    if (!signalId || !exchangeConnectionId || !quantity) {
      return res.status(400).json({
        message: "signalId, exchangeConnectionId, and quantity are required.",
      });
    }

    if (
      !mongoose.isValidObjectId(signalId) ||
      !mongoose.isValidObjectId(exchangeConnectionId)
    ) {
      return res.status(400).json({ message: "Invalid ID format." });
    }

    const parsedQty = parseFloat(quantity);
    if (isNaN(parsedQty) || parsedQty <= 0) {
      return res
        .status(400)
        .json({ message: "quantity must be a positive number." });
    }

    // ── 2. Fetch & validate the signal ───────────────────────────────────────
    const signal = await Signal.findById(signalId).lean();
    if (!signal) {
      return res.status(404).json({ message: "Signal not found." });
    }
    if (signal.status !== "active") {
      return res.status(409).json({
        message: "This signal is no longer active and cannot be copied.",
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
        message:
          "Exchange connection not found or does not belong to your account.",
      });
    }

    // ── 4. Guard against duplicate trade ─────────────────────────────────────
    const existing = await Trade.findOne({
      signalId,
      exchangeConnectionId,
    }).lean();

    if (existing) {
      return res.status(409).json({
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

    // ── 6. Place the order on the exchange ───────────────────────────────────
    let placed;
    try {
      placed = await placeOrder(connection.exchange as ExchangeId, {
        credentials: rawCreds,
        pair: signal.pair,
        direction: signal.direction as "buy" | "sell",
        quantity: String(parsedQty),
        entryPrice: signal.entry,
        tp: signal.tp,
        sl: signal.sl,
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
      tp: signal.tp,
      sl: signal.sl,
      signalId,
      exchangeConnectionId,
      exchangeOrderId: placed.orderId,
      quantity: String(parsedQty),
      entryPrice: signal.entry,
      status: "open",
      rawOrderResponse: placed.raw,
    });

    // ── 8. Binance: attach TP/SL OCO (best-effort, logged on failure) ────────
    if (connection.exchange === "binance") {
      attachBinanceTpSl({
        credentials: rawCreds,
        pair: signal.pair,
        direction: signal.direction as "buy" | "sell",
        quantity: String(parsedQty),
        entryPrice: signal.entry,
        tp: signal.tp,
        sl: signal.sl,
        orderId: placed.orderId,
      }).catch((tpSlErr) => {
        // Non-fatal: polling job will retry resolution
        console.error(
          `[initiateTrade] Binance TP/SL attachment failed for trade ${trade._id}:`,
          tpSlErr,
        );
      });
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

// ─── Refresh Trade Status ─────────────────────────────────────────────────────

/**
 * POST /trades/:tradeId/refresh
 * Manually triggers a status check against the exchange for a single trade.
 * Useful for on-demand refreshes from the UI; background polling is handled
 * separately by the job in tradeStatusJob.ts.
 */
export async function refreshTradeStatus(req: Request, res: Response) {
  try {
    const userId = req.user as mongoose.Types.ObjectId;
    const { tradeId } = req.params;

    if (!mongoose.isValidObjectId(tradeId)) {
      return res.status(400).json({ message: "Invalid trade ID." });
    }

    const trade = await Trade.findOne({ _id: tradeId, userId });
    if (!trade) {
      return res.status(404).json({ message: "Trade not found." });
    }

    if (trade.status !== "open") {
      return res.status(200).json({
        message: "Trade is already resolved.",
        trade,
      });
    }

    if (!trade.exchangeOrderId) {
      return res.status(422).json({
        message: "This trade has no exchange order ID to check.",
      });
    }

    // Fetch the exchange connection for credentials
    const connection = await ExchangeConnection.findById(
      trade.exchangeConnectionId,
    ).lean();

    if (!connection) {
      return res.status(404).json({
        message: "Associated exchange connection not found.",
      });
    }

    const storedCreds = {
      exchange: connection.exchange as ExchangeId,
      apiKey: connection.encryptedApiKey!,
      apiSecret: connection.encryptedApiSecret!,
      ...(connection.encryptedPassphrase
        ? { passphrase: connection.encryptedPassphrase }
        : {}),
    };

    const rawCreds = decryptCredentials(storedCreds);

    let statusResult;
    try {
      statusResult = await getOrderStatus(
        connection.exchange as ExchangeId,
        rawCreds,
        trade.pair,
        trade.exchangeOrderId,
      );
    } catch (statusErr) {
      const message =
        statusErr instanceof Error ? statusErr.message : "Status check failed.";
      return res.status(502).json({
        message: "Failed to fetch order status from exchange.",
        detail: message,
      });
    }

    // Update the trade record
    trade.lastCheckedAt = new Date();
    trade.rawStatusResponse = statusResult.raw;

    if (statusResult.status !== "open") {
      trade.status = statusResult.status;
      if (statusResult.filledPrice) trade.exitPrice = statusResult.filledPrice;

      if (statusResult.status === "closed") {
        trade.closedAt = new Date();
        trade.tradeResult = resolveTradeResult(
          trade.direction as "buy" | "sell",
          trade.entryPrice,
          statusResult.filledPrice,
          trade.tp,
          trade.sl,
        );
      }
    }

    await trade.save();

    return res.status(200).json({ trade });
  } catch (err) {
    console.error("[refreshTradeStatus]", err);
    return res.status(500).json({ message: "Internal server error." });
  }
}

// ─── List User Trades ─────────────────────────────────────────────────────────

/**
 * GET /trades
 * Query params: status (open|closed|cancelled|failed), page, limit
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
