import { randomUUID } from "crypto";
import mongoose from "mongoose";
import { Signal } from "../models/signalModel.js";
import { Trade } from "../models/tradeModel.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import {
  placeOrder,
  getCurrentPrice,
  getExchangeAvailableBalance,
  getFuturesContractRules,
  alignToStep,
  OrderExecutionError,
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
import { queueTradeEmail } from "../services/emailService.js";
import { getProfitShareSummary } from "../services/profitSharingService.js";
import { triggerCopiedTradeClosures } from "./copiedTradeUpdateService.js";

export type TradeOutcome = { status: number; body: Record<string, any> };
const tradeOutcome = (status: number, body: Record<string, any>): TradeOutcome => ({ status, body });

export async function executeTrade(
  userId: mongoose.Types.ObjectId,
  body: Record<string, any>,
  isProTrade: boolean,
): Promise<TradeOutcome> {
  let orderSubmitted = false;
  try {
    const {
      sourceTradeId,
      exchangeConnectionId,
      balance,
      pair,
      tp,
      sl,
      direction,
      entry,
      notes,
    } = body;

    // ── 1. Input validation ──────────────────────────────────────────────────
    if (!exchangeConnectionId || !balance || (!isProTrade && !sourceTradeId)) {
      return tradeOutcome(400, {
        success: false,
        message: isProTrade
          ? "exchangeConnectionId and balance are required."
          : "sourceTradeId, exchangeConnectionId, and balance are required.",
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

    const parsedBalance = parseFloat(balance);
    if (isNaN(parsedBalance) || parsedBalance <= 0) {
      return tradeOutcome(400, {
        success: false,
        message: "balance must be a positive number.",
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
      if (!["buy", "sell"].includes(direction)) {
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
          message: `Approve the ${Number(profitShare.pendingAmount).toFixed(2)} USDT platform profit-share withdrawal before copying another trade.`,
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
        success: true,
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
    const activePairTrade = await Trade.findOne({
      exchangeConnectionId,
      pair: signal.pair,
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
        message: "You have already copied this pro trade on this exchange.",
        trade: { _id: existing._id, status: existing.status },
      });
    }

    // ── 5. Decrypt credentials & verify available exchange funds ─────────────
    const storedCreds = {
      exchange: connection.exchange as ExchangeId,
      apiKey: connection.encryptedApiKey!,
      apiSecret: connection.encryptedApiSecret!,
      ...(connection.encryptedPassphrase
        ? { passphrase: connection.encryptedPassphrase }
        : {}),
    };

    const rawCreds = decryptCredentials(storedCreds);

    let availableFunds: number;
    try {
      availableFunds = await getExchangeAvailableBalance(
        connection.exchange as ExchangeId,
        rawCreds,
      );
    } catch (balErr) {
      const message =
        balErr instanceof Error
          ? balErr.message
          : "Available exchange balance verification failed.";
      console.error("[initiateTrade] Balance verification error:", message);
      return tradeOutcome(502, {
        message: "Failed to verify available exchange balance.",
        detail: message,
      });
    }

    if (!Number.isFinite(availableFunds) || availableFunds <= 0) {
      return tradeOutcome(422, {
        message: "No available futures margin on connected exchange account.",
      });
    }

    // Preserve subscription allocation: use allocation for copies, but enforce available funds cap
    const effectiveBalance = Math.min(parsedBalance, availableFunds);
    if (effectiveBalance <= 0) {
      return tradeOutcome(422, {
        message: "Effective balance for trade sizing is zero or negative.",
      });
    }

    // ── 5b. Fetch current market price ───────────────────────────────────────
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
      return tradeOutcome(502, {
        message: "Failed to fetch current market price.",
        detail: message,
      });
    }

    const signalEntryPrice = parseFloat(signal.entry);
    const currentPrice = parseFloat(currentPriceResult.price);

    if (!Number.isFinite(signalEntryPrice) || signalEntryPrice <= 0) {
      return tradeOutcome(422, {
        message: "Signal entry price is invalid.",
      });
    }

    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return tradeOutcome(502, {
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
      return tradeOutcome(409, {
        message: "Current market price is too far from the signal entry price.",
        pair: signal.pair,
        entryPrice: signal.entry,
        currentPrice: currentPriceResult.price,
        deviation: Number(deviation.toFixed(6)),
        maxDeviation,
      });
    }

    // ── 6. Fetch contract specifications & apply 2% risk model ───────────────
    let contractRules;
    try {
      contractRules = await getFuturesContractRules(
        connection.exchange as ExchangeId,
        signal.pair,
      );
    } catch (rulesErr) {
      const message =
        rulesErr instanceof Error
          ? rulesErr.message
          : "Contract rules lookup failed.";
      return tradeOutcome(502, {
        message: "Failed to retrieve exchange contract rules.",
        detail: message,
      });
    }

    const testnetScale = rebaseForTestnet
      ? currentPrice / signalEntryPrice
      : 1;
    const executionEntryPrice = rebaseForTestnet
      ? currentPrice
      : signalEntryPrice;
    const executionTpPrice = parseFloat(signal.tp) * testnetScale;
    const executionSlPrice = parseFloat(signal.sl) * testnetScale;

    // Align prices to exchange price tick
    const alignedEntry = alignToStep(String(executionEntryPrice), contractRules.tickSize);
    const alignedTp = alignToStep(String(executionTpPrice), contractRules.tickSize);
    const alignedSl = alignToStep(String(executionSlPrice), contractRules.tickSize);

    const validLevels =
      Number.isFinite(Number(alignedTp)) &&
      Number.isFinite(Number(alignedSl)) &&
      Number(alignedTp) > 0 &&
      Number(alignedSl) > 0 &&
      (signal.direction === "buy"
        ? Number(alignedSl) < Number(alignedEntry) &&
          Number(alignedEntry) < Number(alignedTp)
        : Number(alignedTp) < Number(alignedEntry) &&
          Number(alignedEntry) < Number(alignedSl));

    if (!validLevels) {
      return tradeOutcome(422, {
        message:
          "Signal price levels are invalid for its direction. A long requires SL < entry < TP; a short requires TP < entry < SL.",
      });
    }

    const priceDistance = Math.abs(Number(alignedEntry) - Number(alignedSl));
    if (!Number.isFinite(priceDistance) || priceDistance <= 0) {
      return tradeOutcome(422, {
        message:
          "Cannot calculate position size: entry and stop-loss prices are too close or identical after tick alignment.",
      });
    }

    // 2% risk calculation:
    // riskAmount = effectiveBalance * MAX_RISK_PERCENT (0.02)
    // quantity = riskAmount / (abs(entry - stopLoss) * contractMultiplier)
    const multiplier = Number(contractRules.multiplier);
    const qtyStep = Number(contractRules.qtyStep);

    if (
      !Number.isFinite(effectiveBalance) || effectiveBalance <= 0 ||
      !Number.isFinite(priceDistance) || priceDistance <= 0 ||
      !Number.isFinite(multiplier) || multiplier <= 0 ||
      !Number.isFinite(qtyStep) || qtyStep <= 0
    ) {
      return tradeOutcome(422, {
        message: "Invalid contract or sizing parameters: balance, price distance, multiplier, or quantity step is invalid.",
      });
    }

    const riskAmount = effectiveBalance * MAX_RISK_PERCENT;
    if (!Number.isFinite(riskAmount) || riskAmount <= 0) {
      return tradeOutcome(422, {
        message: "Calculated risk amount is invalid.",
      });
    }

    const rawQuantity = riskAmount / (priceDistance * multiplier);
    if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) {
      return tradeOutcome(422, {
        message: "Calculated order quantity is invalid.",
      });
    }

    // Safe rounding: round DOWN to lot step to ensure risk never exceeds 2%
    let stepUnits = Math.floor(rawQuantity / qtyStep + 1e-12);
    let safeQuantityNum = stepUnits * qtyStep;
    let safeQuantity = alignToStep(String(safeQuantityNum), contractRules.qtyStep, true);

    // Iteratively ensure actual risk is <= riskAmount (strictly <= without margin for error)
    while (
      stepUnits > 0 &&
      (Number(safeQuantity) * priceDistance * multiplier > riskAmount || Number(safeQuantity) <= 0)
    ) {
      stepUnits--;
      safeQuantityNum = stepUnits * qtyStep;
      safeQuantity = alignToStep(String(safeQuantityNum), contractRules.qtyStep, true);
    }

    // Final unconditional risk check on exact exchange-aligned parameters
    const finalQuantityNum = Number(safeQuantity);
    const finalPriceDistance = Math.abs(Number(alignedEntry) - Number(alignedSl));
    const finalActualRisk = finalQuantityNum * finalPriceDistance * multiplier;

    if (
      !Number.isFinite(finalQuantityNum) ||
      finalQuantityNum <= 0 ||
      !Number.isFinite(finalActualRisk) ||
      finalActualRisk > riskAmount
    ) {
      return tradeOutcome(422, {
        message: "Calculated order quantity violates the 2% maximum risk limit.",
        actualRisk: finalActualRisk,
        maxRiskAllowed: riskAmount,
      });
    }

    // Verify exchange minimum requirements - NEVER increase quantity if it breaches 2% risk!
    if (finalQuantityNum < Number(contractRules.minQty)) {
      return tradeOutcome(422, {
        message: `Calculated quantity (${safeQuantity}) is below ${connection.exchange} minimum order quantity (${contractRules.minQty}) for ${signal.pair}. Increase allocation or balance to satisfy exchange minimums within the 2% risk limit.`,
      });
    }

    const orderNotional = finalQuantityNum * Number(alignedEntry);
    if (orderNotional < Number(contractRules.minNotional)) {
      return tradeOutcome(422, {
        message: `Calculated order notional (${orderNotional.toFixed(2)} USDT) is below ${connection.exchange} minimum notional requirement (${contractRules.minNotional} USDT) for ${signal.pair}. Increase allocation or balance to satisfy exchange minimums within the 2% risk limit.`,
      });
    }

    // ── 7. Place the order on the exchange ───────────────────────────────────
    const exchangeClientOrderId = `sc_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    let placed;
    try {
      placed = await placeOrder(connection.exchange as ExchangeId, {
        credentials: rawCreds,
        pair: signal.pair,
        direction: signal.direction as "buy" | "sell",
        clientOrderId: exchangeClientOrderId,
        quantity: safeQuantity,
        entryPrice: alignedEntry,
        tp: alignedTp,
        sl: alignedSl,
      });
    } catch (orderErr) {
      if (orderErr instanceof OrderExecutionError) {
        console.error(`[initiateTrade] ${orderErr.classification}:`, {
          exchange: orderErr.exchange,
          status: orderErr.status,
          code: orderErr.exchangeCode,
          clientOrderId: orderErr.clientOrderId,
          message: orderErr.originalMessage,
        });

        if (orderErr.classification === "AMBIGUOUS_OUTCOME") {
          return tradeOutcome(502, {
            message: "Order placement outcome is ambiguous due to network or exchange interruption. Manual review required.",
            code: "ORDER_REVIEW_REQUIRED",
            exchange: orderErr.exchange,
            clientOrderId: orderErr.clientOrderId,
            detail: orderErr.originalMessage,
          });
        }

        // Confirmed rejection: do not require manual review, do not lock automatic copy queue
        return tradeOutcome(422, {
          message: orderErr.message,
          code: "ORDER_REJECTED",
          exchange: orderErr.exchange,
          detail: orderErr.originalMessage,
        });
      }

      const message =
        orderErr instanceof Error
          ? orderErr.message
          : "Order placement failed.";
      console.error("[initiateTrade] Exchange error:", message);
      return tradeOutcome(502, {
        message: "Failed to place order on exchange.",
        code: "ORDER_REVIEW_REQUIRED",
        detail: message,
      });
    }

    // ── 8. Persist trade record ──────────────────────────────────────────────
    orderSubmitted = true;

    // Persist signal for pro trade (if signal.save fails, don't abort since order was accepted by exchange)
    if (isProTrade) {
      try {
        await signal.save();
      } catch (signalErr) {
        console.error("[initiateTrade] Warning: Signal save failed after exchange acceptance:", {
          exchangeOrderId: placed.orderId,
          clientOrderId: exchangeClientOrderId,
          error: signalErr instanceof Error ? signalErr.message : signalErr,
        });
      }
    }

    let trade;
    try {
      trade = await Trade.create({
        userId,
        pair: signal.pair,
        direction: signal.direction,
        tp: placed.execution?.tp ?? alignedTp,
        sl: placed.execution?.sl ?? alignedSl,
        signalId,
        tradeOrigin: isProTrade ? "pro" : "copy",
        sourceTradeId: isProTrade ? null : sourceTradeId,
        exchangeConnectionId,
        exchangeOrderId: placed.orderId,
        exchangeClientOrderId,
        quantity: placed.execution?.quantity ?? safeQuantity,
        entryPrice: placed.execution?.entryPrice ?? alignedEntry,
        status: "pending",
        wsMonitoringActive: false,
        monitoringStatus: "connecting",
        monitoringError: null,
        rawOrderResponse: {
          order: placed.raw,
          marketPrice: currentPriceResult.raw,
          sizing: {
            requestedBalance: parsedBalance,
            availableFunds,
            effectiveBalance,
            riskPercent: MAX_RISK_PERCENT,
            riskAmount,
            actualRisk: finalActualRisk,
            contractMultiplier: multiplier,
            priceDistance: finalPriceDistance,
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
    } catch (persistErr) {
      console.error("[initiateTrade] CRITICAL: Exchange order submitted but DB persistence failed:", {
        exchange: connection.exchange,
        exchangeOrderId: placed.orderId,
        clientOrderId: exchangeClientOrderId,
        error: persistErr instanceof Error ? persistErr.message : persistErr,
      });

      // Avoid creating duplicate trade records if one already exists
      try {
        trade = await Trade.findOne({
          $or: [
            { exchangeOrderId: placed.orderId },
            { exchangeClientOrderId },
          ],
        });
      } catch (findErr) {
        // ignore
      }

      if (!trade) {
        try {
          trade = await Trade.create({
            userId,
            pair: signal.pair,
            direction: signal.direction,
            tp: placed.execution?.tp ?? alignedTp,
            sl: placed.execution?.sl ?? alignedSl,
            signalId,
            tradeOrigin: isProTrade ? "pro" : "copy",
            sourceTradeId: isProTrade ? null : sourceTradeId,
            exchangeConnectionId,
            exchangeOrderId: placed.orderId,
            exchangeClientOrderId,
            quantity: placed.execution?.quantity ?? safeQuantity,
            entryPrice: placed.execution?.entryPrice ?? alignedEntry,
            status: "pending",
            wsMonitoringActive: false,
            monitoringStatus: "review_required",
            monitoringError: "Database persistence error after exchange submission; review required.",
          });
        } catch (emergencyErr) {
          console.error("[initiateTrade] CRITICAL PERSISTENCE FAILURE - Emergency persistence failed:", {
            exchange: connection.exchange,
            exchangeOrderId: placed.orderId,
            clientOrderId: exchangeClientOrderId,
            userId: String(userId),
            pair: signal.pair,
            direction: signal.direction,
            quantity: safeQuantity,
            entryPrice: alignedEntry,
            error: emergencyErr instanceof Error ? emergencyErr.message : emergencyErr,
          });
        }
      }

      return tradeOutcome(500, {
        success: false,
        code: "ORDER_REVIEW_REQUIRED",
        message: "Order was placed on exchange, but trade record could not be confirmed. Manual review required.",
        exchangeOrderId: placed.orderId,
        clientOrderId: exchangeClientOrderId,
        exchange: connection.exchange,
      });
    }

    queueTradeEmail(userId, isProTrade ? "opened" : "copied", {
      pair: trade.pair,
      direction: trade.direction,
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
    });

    let monitoringWarning: string | null = null;
    try {
      await getTradeMonitorService().startMonitoring(String(trade._id));
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
    console.error("[initiateTrade]", err);
    return tradeOutcome(500, {
      message: "Internal server error.",
      ...(orderSubmitted ? { code: "ORDER_REVIEW_REQUIRED" } : {}),
    });
  }
}
