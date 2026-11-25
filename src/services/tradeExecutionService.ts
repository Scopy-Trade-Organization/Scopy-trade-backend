import { planTrade } from "./tradePlanningService.js";
import { prepareBitgetPair } from "./bitgetSetupService.js";
import { TradeRiskError, D } from "./tradeRiskService.js";
import { getFuturesContext, configureLeverage, refreshAvailableFuturesBalance } from "./futuresExchangeService.js";
import { verifyOrRecoverProtection, ProtectionFailure } from "./tradeProtectionService.js";
import { processTradeClose } from "./profitSharingService.js";
import { randomUUID } from "crypto";
import mongoose from "mongoose";
import { Signal } from "../models/signalModel.js";
import { Trade } from "../models/tradeModel.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import {
  placeOrder,
  getCurrentPrice,
} from "../services/tradeService.js";
import { ExchangeId } from "../types/index.js";
import { decryptCredentials } from "../services/exchangeConnectionService.js";
import { getTradeMonitorService } from "../services/tradeMonitorService.js";
import {
  getExchangeMode,
} from "../services/exchangeEnvironment.js";
import {
  SUPPORTED_PAIRS,
  SUPPORTED_TRADE_EXCHANGES,
} from "../constants.js";
import { queueTradeEmail } from "../services/emailService.js";
import { getProfitShareSummary } from "../services/profitSharingService.js";
import { triggerCopiedTradeClosures } from "./copiedTradeUpdateService.js";


export type TradeOutcome = { status: number; body: Record<string, any> };
const tradeOutcome = (status: number, body: Record<string, any>): TradeOutcome => ({ status, body });

export interface ExecutionDependencies {
  getFuturesContext?: typeof getFuturesContext;
  configureLeverage?: typeof configureLeverage;
  refreshAvailableFuturesBalance?: typeof refreshAvailableFuturesBalance;
  placeOrder?: typeof placeOrder;
  getCurrentPrice?: typeof getCurrentPrice;
  verifyOrRecoverProtection?: typeof verifyOrRecoverProtection;
  startMonitoring?: (id: string) => Promise<void>;
}
export async function executeTrade(userId: mongoose.Types.ObjectId, body: Record<string, any>, isProTrade: boolean, dependencies: ExecutionDependencies = {}): Promise<TradeOutcome> {
  let orderSubmitted = false;
  let lockToken: string | undefined;
  let attempt: any;
  let lockedConnectionId: string | undefined;
  try {
    const {
      sourceTradeId,
      exchangeConnectionId,
      pair,
      tp,
      sl,
      direction,
      entry,
      notes,
    } = body;

    // ── 1. Input validation ──────────────────────────────────────────────────
    if (!exchangeConnectionId || (!isProTrade && !sourceTradeId)) {
      return tradeOutcome(400, {
        success: false,
        message: isProTrade
          ? "exchangeConnectionId is required."
          : "sourceTradeId and exchangeConnectionId are required.",
      });
    }

    if (
      (!isProTrade && !mongoose.isValidObjectId(sourceTradeId)) ||
      !mongoose.isValidObjectId(exchangeConnectionId)
    ) {
      return tradeOutcome(400, {
        success: false,
        message: "Invalid ID format.",
      });
    }

    // ── 2. Fetch & validate the signal ───────────────────────────────────────
    let signal: any;
    let signalId: mongoose.Types.ObjectId;

    if (isProTrade) {
      if (!pair || !tp || !sl || !direction || !entry) {
        return tradeOutcome(400, {
          success: false,
          message: "pair, entry, tp, sl, and direction are required.",
        });
      }
      if (!['buy', 'sell'].includes(direction)) {
        return tradeOutcome(400, {
          success: false,
          message: "direction must be either buy or sell.",
        });
      }

      signal = new Signal({
        pair,
        tp,
        sl,
        entry,
        direction,
        notes,
        trader: userId,
      });
      signalId = signal._id;
    } else {
      const sourceTrade = await Trade.findOne({
        _id: sourceTradeId,
        tradeOrigin: "pro",
        protectionStatus: "confirmed",
        status: { $in: ["pending", "filled"] },
      }).lean();

      if (!sourceTrade) {
        return tradeOutcome(404, {
          success: false,
          message: "Active pro trade not found.",
        });
      }

      signalId = sourceTrade.signalId;
      const template = await Signal.findById(signalId).lean();
      signal = template
        ? {
            ...template,
            pair: sourceTrade.pair,
            direction: sourceTrade.direction,
            entry: sourceTrade.entryFillPrice ?? sourceTrade.entryPrice,
            tp: sourceTrade.tp,
            sl: sourceTrade.sl,
          }
        : null;
    }

    if (!isProTrade) {
      const profitShare = await getProfitShareSummary(userId);
      if (profitShare.withdrawalRequired) {
        return tradeOutcome(402, {
          success: false,
          code: "PROFIT_SHARE_DUE",
          message: `Settle the ${Number(profitShare.pendingAmount).toFixed(2)} USDT profit share in your dashboard before copying another trade.`,
          profitShare,
        });
      }
    }

    if (!signal) {
      return tradeOutcome(404, {
        success: false,
        message: "The pro trade execution template was not found.",
      });
    }
    if (!isProTrade && signal.status !== "active") {
      return tradeOutcome(409, {
        success: false,
        message: "This pro trade is no longer active and cannot be copied.",
      });
    }

    // ── 2b. Validate trading pair is supported ───────────────────────────────
    const normalizedPair = signal.pair.toUpperCase().replace(/[/-]/g, "");
    if (!SUPPORTED_PAIRS.includes(normalizedPair as any)) {
      return tradeOutcome(422, {
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
      return tradeOutcome(404, {
        success: false,
        message:
          "Exchange connection not found or does not belong to your account.",
      });
    }

    // ── 3b. Validate exchange is supported for trading ───────────────────────
    if (!SUPPORTED_TRADE_EXCHANGES.includes(connection.exchange as ExchangeId)) {
      return tradeOutcome(422, {
        success: false,
        message: `Exchange "${connection.exchange}" is not currently supported for trading. Supported: ${SUPPORTED_TRADE_EXCHANGES.join(", ")}`,
      });
    }

    // ── 4. Guard against duplicate trade ─────────────────────────────────────
    // Futures exchanges maintain a position per symbol on an account. Keeping
    // one active local trade per pair/connection lets WebSocket and REST
    // reconciliation unambiguously associate an exchange close with this trade.
    const activePairTrade = await Trade.findOne({
      exchangeConnectionId,
      pair: normalizedPair,
      status: { $in: ["pending", "filled"] },
    }).lean();

    if (activePairTrade) {
      return tradeOutcome(409, {
        success: false,
        message: `An active ${signal.pair} trade already exists on this exchange connection. Close or cancel it before opening another ${signal.pair} trade.`,
        trade: { _id: activePairTrade._id, status: activePairTrade.status },
      });
    }

    const existing = isProTrade
      ? null
      : await Trade.findOne({ sourceTradeId, exchangeConnectionId }).lean();

    if (existing) {
      return tradeOutcome(409, {
        success: false,
        message:
          "You have already copied this pro trade on this exchange.",
        trade: { _id: existing._id, status: existing.status },
      });
    }

    lockToken = randomUUID();
    const locked = await ExchangeConnection.findOneAndUpdate({ _id: connection._id, userId, isActive: true,
      $or: [{ executionLockUntil: null }, { executionLockUntil: { $lte: new Date() } }],
    }, { $set: { executionLockToken: lockToken, executionLockUntil: new Date(Date.now() + 5 * 60_000) } });
    if (!locked) return tradeOutcome(409, { success: false, code: "EXECUTION_BUSY", message: "Another trade is being prepared on this exchange account. Try again shortly." });
    lockedConnectionId = String(connection._id);
    // Recheck after acquiring the account lock; the first lookup is only an early hint.
    if (await Trade.exists({ exchangeConnectionId: connection._id, pair: normalizedPair, status: { $in: ["pending", "filled"] } })) {
      return tradeOutcome(409, { success: false, message: "An active trade already exists for this symbol on the connected account." });
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

    const exchange = connection.exchange as ExchangeId;
    if (exchange === "bitget") await prepareBitgetPair(rawCreds, normalizedPair);
    const { sizing, context, signalPricesRebased: rebaseForTestnet } = await planTrade(exchange, rawCreds, signal, dependencies);
    await (dependencies.configureLeverage ?? configureLeverage)(exchange, rawCreds, context, sizing);
    const availableAtSubmission = await (dependencies.refreshAvailableFuturesBalance ?? refreshAvailableFuturesBalance)(exchange, rawCreds, context);
    if (new D(sizing.estimatedRiskAmount).gt(new D(availableAtSubmission).mul("0.02")) || new D(sizing.initialMargin).plus(sizing.marginReserve).gt(availableAtSubmission)) {
      throw new TradeRiskError("BALANCE_CHANGED", "Available futures margin changed while preparing the trade. Refresh and try again; no entry was submitted.");
    }
    Object.assign(sizing, { availableBalanceAtSubmission: availableAtSubmission });

    if (!isProTrade && (await getProfitShareSummary(userId)).settlementRequired) {
      return tradeOutcome(402, { success: false, code: "PROFIT_SHARE_DUE", message: "Settle your outstanding profit share in your dashboard before copying another trade." });
    }
    const exchangeClientOrderId = `sc${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    if (isProTrade) await signal.save();
    // Save the client ID before the network call. A lost response is reconciled, never blindly retried.
    attempt = await Trade.create({ userId, pair: normalizedPair, direction: signal.direction,
      tp: sizing.takeProfitPrice, sl: sizing.stopLossPrice, signalId, tradeOrigin: isProTrade ? "pro" : "copy",
      sourceTradeId: isProTrade ? null : sourceTradeId, exchangeConnectionId, exchangeClientOrderId,
      quantity: sizing.positionQuantity, entryPrice: sizing.entryPrice, status: "pending",
      sizing, leverage: sizing.leverage, marginMode: context.marginMode, protectionStatus: "pending",
      rawOrderResponse: { sizing, exchangeMode: getExchangeMode(), signalPricesRebased: rebaseForTestnet },
    });
    const orderParams = { credentials: rawCreds, pair: normalizedPair, direction: signal.direction as "buy" | "sell",
      clientOrderId: exchangeClientOrderId, quantity: sizing.positionQuantity, entryPrice: sizing.entryPrice,
      tp: sizing.takeProfitPrice, sl: sizing.stopLossPrice, sizing, marginMode: context.marginMode };
    orderSubmitted = true;
    const placed = await (dependencies.placeOrder ?? placeOrder)(exchange, orderParams);
    if (!placed.orderId) throw new TradeRiskError("ORDER_REVIEW_REQUIRED", "No exchange order ID was returned. Check the exchange before retrying.");
    attempt.exchangeOrderId = placed.orderId;
    attempt.rawOrderResponse = { sizing, exchangeMode: getExchangeMode(), order: placed.raw };
    await attempt.save();
    try {
      await (dependencies.verifyOrRecoverProtection ?? verifyOrRecoverProtection)(exchange, { ...orderParams,
        orderId: placed.orderId, clientOrderId: exchangeClientOrderId, orderQuantity: sizing.orderQuantity });
    } catch (error) {
      if (error instanceof ProtectionFailure) {
        attempt.protectionStatus = error.recovery === "review" ? "review" : "failed";
        attempt.protectionError = error.message;
        attempt.protectionDiagnostics = error.diagnostics;
        attempt.monitoringError = error.message;
        if (error.closedQuantity) attempt.quantity = error.closedQuantity;
        if (error.entryFillPrice) attempt.entryFillPrice = error.entryFillPrice;
        if (error.recovery === "cancelled") attempt.status = "cancelled";
        await attempt.save();
        if (error.recovery === "closed" && error.exitPrice) await processTradeClose(String(attempt._id), error.exitPrice, "manual");
        if (error.recovery === "review") await (dependencies.startMonitoring ?? (id => getTradeMonitorService().startMonitoring(id)))(String(attempt._id)).catch(() => undefined);
        return tradeOutcome(502, { success: false, code: error.recovery === "review" ? "ORDER_REVIEW_REQUIRED" : error.code,
          message: error.message, tradeId: String(attempt._id), exchangeOrderId: placed.orderId, recovery: error.recovery, protectionDiagnostics: error.diagnostics });
      }
      throw error;
    }
    attempt.protectionStatus = "confirmed";
    attempt.protectionCheckedAt = new Date();
    await attempt.save();
    let trade = attempt;
    let monitoringWarning: string | null = null;
    try {
      await (dependencies.startMonitoring ?? (id => getTradeMonitorService().startMonitoring(id)))(String(trade._id));
    } catch (monitorErr) {
      monitoringWarning =
        monitorErr instanceof Error
          ? monitorErr.message
          : "Real-time monitoring could not be started.";
      await Trade.updateOne(
        { _id: trade._id },
        {
          $set: {
            wsMonitoringActive: false,
            monitoringStatus: "disconnected",
            monitoringError: monitoringWarning,
          },
        },
      );
      console.error("[initiateTrade] Failed to start trade monitor:", monitorErr);
    }

    // Monitoring can discover a fill/protection failure before the HTTP reply.
    // Report its persisted result instead of the earlier pending snapshot.
    trade = await Trade.findById(trade._id) ?? trade;
    if (trade.protectionStatus !== "confirmed") {
      return tradeOutcome(502, { success: false, code: trade.protectionStatus === "review" ? "ORDER_REVIEW_REQUIRED" : "STOP_LOSS_PROTECTION_FAILED",
        message: trade.protectionError || "Stop-loss protection requires exchange review.", tradeId: String(trade._id), exchangeOrderId: trade.exchangeOrderId,
        protectionDiagnostics: trade.protectionDiagnostics });
    }
    queueTradeEmail(userId, isProTrade ? "opened" : "copied", {
      pair: trade.pair,
      direction: trade.direction,
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
    });

    if (!isProTrade) {
      const source = await Trade.findById(sourceTradeId).select("status").lean();
      if (source && !["pending", "filled"].includes(source.status)) triggerCopiedTradeClosures(String(sourceTradeId));
    }

    return tradeOutcome(201, {
      success: true,
      message: isProTrade
        ? "Pro trade opened successfully."
        : "Copy trade initiated successfully.",
      monitoringWarning,
      trade: {
        _id: trade._id,
        pair: trade.pair,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        tp: trade.tp,
        sl: trade.sl,
        quantity: trade.quantity,
        leverage: trade.leverage,
        sizing: { ...sizing, riskPercent: 100 * sizing.riskPercent },
        protectionStatus: trade.protectionStatus,
        status: trade.status,
        tradeOrigin: trade.tradeOrigin,
        sourceTradeId: trade.sourceTradeId,
        exchangeOrderId: trade.exchangeOrderId,
        wsMonitoringActive: monitoringWarning === null && trade.wsMonitoringActive,
        monitoringStatus: monitoringWarning ? "disconnected" : "connecting",
        monitoringError: monitoringWarning,
        createdAt: trade.createdAt,
      },
    });
  } catch (err) {
    const safeMessage = err instanceof TradeRiskError ? err.message : "The exchange could not complete or confirm this trade. Check its order history before retrying.";
    if (attempt && orderSubmitted) {
      const rejected = err instanceof TradeRiskError && err.code === "EXCHANGE_REJECTED";
      await Trade.updateOne({ _id: attempt._id }, { $set: { ...(rejected ? { status: "failed" } : {}),
        protectionStatus: rejected ? "failed" : "review", protectionError: safeMessage, monitoringError: safeMessage } }).catch(() => undefined);
      return tradeOutcome(502, { success: false, message: safeMessage, code: rejected ? err.code : "ORDER_REVIEW_REQUIRED",
        tradeId: String(attempt._id), clientOrderId: attempt.exchangeClientOrderId });
    }
    if (err instanceof TradeRiskError) return tradeOutcome(err.code === "EXCHANGE_UNAVAILABLE" ? 502 : err.code === "ENTRY_DEVIATION" ? 409 : 422, { success: false, code: err.code, message: err.message });
    return tradeOutcome(503, { success: false, message: "Trade preparation is unavailable. Check the connected futures account and try again." });
  } finally {
    if (lockedConnectionId && lockToken) await ExchangeConnection.updateOne({ _id: lockedConnectionId, executionLockToken: lockToken },
      { $unset: { executionLockToken: 1, executionLockUntil: 1 } }).catch(() => undefined);
  }
}
