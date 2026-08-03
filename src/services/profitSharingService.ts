import { Trade } from "../models/tradeModel.js";
import { PLATFORM_FEE_PERCENT } from "../constants.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TradeCloseResult {
  tradeId: string;
  realizedPnl: string;
  platformFee: string;
  feeStatus: "pending" | "waived";
  tradeResult: "profit" | "loss" | "breakeven";
}

// ─── PnL Calculation ────────────────────────────────────────────────────────

/**
 * Calculates realized PnL for a closed trade.
 *
 * PnL = (exitPrice - entryFillPrice) × quantity   (for long / buy)
 * PnL = (entryFillPrice - exitPrice) × quantity   (for short / sell)
 */
function calculateRealizedPnl(
  direction: "buy" | "sell",
  entryFillPrice: string,
  exitPrice: string,
  quantity: string,
): number {
  const entry = parseFloat(entryFillPrice);
  const exit = parseFloat(exitPrice);
  const qty = parseFloat(quantity);

  if (!Number.isFinite(entry) || !Number.isFinite(exit) || !Number.isFinite(qty)) {
    return 0;
  }

  return direction === "buy"
    ? (exit - entry) * qty
    : (entry - exit) * qty;
}

/**
 * Determines the trade result category based on realized PnL.
 */
function classifyResult(pnl: number): "profit" | "loss" | "breakeven" {
  if (pnl > 0) return "profit";
  if (pnl < 0) return "loss";
  return "breakeven";
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Processes a trade closure: calculates realized PnL, determines the platform
 * fee (10% of profit), and updates the trade record in the database.
 *
 * Called by the TradeMonitorService when a trade closes via TP, SL, or manual.
 *
 * @param tradeId  Mongo _id of the trade
 * @param exitPrice  The price at which the position was closed
 * @param closedVia  How the trade was closed: "tp" | "sl" | "manual"
 */
export async function processTradeClose(
  tradeId: string,
  exitPrice: string,
  closedVia: "tp" | "sl" | "manual",
): Promise<TradeCloseResult> {
  const trade = await Trade.findById(tradeId);

  if (!trade) {
    throw new Error(`[profitSharingService] Trade ${tradeId} not found.`);
  }

  if (trade.status === "closed") {
    console.warn(`[profitSharingService] Trade ${tradeId} is already closed. Skipping.`);
    return {
      tradeId,
      realizedPnl: trade.realizedPnl || "0",
      platformFee: trade.platformFee || "0",
      feeStatus: (trade.feeStatus as "pending" | "waived") || "waived",
      tradeResult: (trade.tradeResult as "profit" | "loss" | "breakeven") || "breakeven",
    };
  }

  // Use entryFillPrice if available, otherwise fall back to entryPrice (the signal price)
  const entryFillPrice = trade.entryFillPrice || trade.entryPrice;

  const pnl = calculateRealizedPnl(
    trade.direction as "buy" | "sell",
    entryFillPrice,
    exitPrice,
    trade.quantity,
  );

  const tradeResult = classifyResult(pnl);

  // Platform fee: 10% of profit on winning trades only
  let platformFee = 0;
  let feeStatus: "pending" | "waived" = "waived";

  // Pro trades are the source strategy. Performance fees apply only to
  // copy-trader positions opened from that strategy.
  if (trade.tradeOrigin === "copy" && tradeResult === "profit") {
    platformFee = pnl * PLATFORM_FEE_PERCENT;
    feeStatus = "pending";
  }

  // Update the trade record
  await Trade.updateOne(
    { _id: tradeId },
    {
      $set: {
        status: "closed",
        exitPrice,
        closedVia,
        closedAt: new Date(),
        realizedPnl: pnl.toFixed(6),
        platformFee: platformFee.toFixed(6),
        feeStatus,
        tradeResult,
        wsMonitoringActive: false,
      },
    },
  );

  console.log(
    `[profitSharingService] Trade ${tradeId} closed via ${closedVia}: ` +
      `PnL=${pnl.toFixed(4)} USDT, fee=${platformFee.toFixed(4)} USDT (${feeStatus})`,
  );

  return {
    tradeId,
    realizedPnl: pnl.toFixed(6),
    platformFee: platformFee.toFixed(6),
    feeStatus,
    tradeResult,
  };
}
