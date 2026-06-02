/**
 * tradeStatusJob.ts
 *
 * Background polling job that periodically checks pending entry orders against
 * their respective exchanges and advances them to filled / cancelled / failed.
 *
 * Run this with node-cron (or equivalent) — recommended interval: every 2 minutes.
 *
 * Usage (in your app entrypoint):
 *   import { startTradeStatusJob } from "./jobs/tradeStatusJob.js";
 *   startTradeStatusJob();
 */

import cron from "node-cron";
import { Trade } from "../models/tradeModel.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import {
  decryptCredentials,
  getOrderStatus,
  attachBinanceTpSl,
} from "../services/exchangeService.js";
import { ExchangeId } from "../types/index.js";

// Maximum number of trades to process per job run (prevents overloading exchanges)
const BATCH_SIZE = 50;

// Minimum milliseconds between checks for the same trade
// 2 minutes — respects exchange rate limits
const MIN_CHECK_INTERVAL_MS = 2 * 60 * 1000;

async function processBatch() {
  console.log("[tradeStatusJob] Starting batch...");

  const cutoff = new Date(Date.now() - MIN_CHECK_INTERVAL_MS);

  // Fetch pending entry orders that haven't been checked recently
  const pendingTrades = await Trade.find({
    status: "pending",
    exchangeOrderId: { $ne: null },
    $or: [{ lastCheckedAt: null }, { lastCheckedAt: { $lte: cutoff } }],
  })
    .limit(BATCH_SIZE)
    .lean();

  if (!pendingTrades.length) {
    console.log("[tradeStatusJob] No trades to process.");
    return;
  }

  console.log(`[tradeStatusJob] Processing ${pendingTrades.length} trades.`);

  // Group by exchangeConnectionId to reuse decrypted credentials
  const connectionIds = [
    ...new Set(pendingTrades.map((t) => t.exchangeConnectionId.toString())),
  ];

  const connections = await ExchangeConnection.find({
    _id: { $in: connectionIds },
  }).lean();

  const connectionMap = new Map(connections.map((c) => [c._id.toString(), c]));

  // Process each trade independently — don't let one failure abort the rest
  await Promise.allSettled(
    pendingTrades.map(async (trade) => {
      const connection = connectionMap.get(
        trade.exchangeConnectionId.toString(),
      );

      if (!connection) {
        console.warn(
          `[tradeStatusJob] No connection found for trade ${trade._id}`,
        );
        return;
      }

      try {
        const storedCreds = {
          exchange: connection.exchange as ExchangeId,
          apiKey: connection.encryptedApiKey!,
          apiSecret: connection.encryptedApiSecret!,
          ...(connection.encryptedPassphrase
            ? { passphrase: connection.encryptedPassphrase }
            : {}),
        };

        const rawCreds = decryptCredentials(storedCreds);

        const statusResult = await getOrderStatus(
          connection.exchange as ExchangeId,
          rawCreds,
          trade.pair,
          trade.exchangeOrderId!,
        );

        // Build the update payload
        const update: Record<string, unknown> = {
          lastCheckedAt: new Date(),
          rawStatusResponse: statusResult.raw,
        };

        if (statusResult.status !== "pending") {
          update.status = statusResult.status;

          if (statusResult.filledPrice) {
            update.entryFillPrice = statusResult.filledPrice;
          }

          if (statusResult.status === "filled") {
            // Binance: entry filled → now place the TP/SL OCO
            if (connection.exchange === "binance") {
              attachBinanceTpSl({
                credentials: rawCreds,
                pair: trade.pair,
                direction: trade.direction as "buy" | "sell",
                quantity: trade.quantity,
                entryPrice: trade.entryPrice,
                tp: trade.tp,
                sl: trade.sl,
                orderId: trade.exchangeOrderId!,
              }).catch((err) => {
                console.error(
                  `[tradeStatusJob] Binance TP/SL failed for trade ${trade._id}:`,
                  err,
                );
              });
            }
          }
        }

        await Trade.updateOne({ _id: trade._id }, { $set: update });

        console.log(
          `[tradeStatusJob] Trade ${trade._id} → ${statusResult.status}`,
        );
      } catch (err) {
        console.error(
          `[tradeStatusJob] Failed to check trade ${trade._id}:`,
          err,
        );
        // Update lastCheckedAt so it backs off rather than hammering the exchange
        await Trade.updateOne(
          { _id: trade._id },
          { $set: { lastCheckedAt: new Date() } },
        );
      }
    }),
  );

  console.log("[tradeStatusJob] Batch complete.");
}

/**
 * Heuristic trade result resolver — mirrors the one in tradeController.ts.
 * In a production system, read which OCO arm was triggered from the exchange.
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
  const band = entry * 0.0005;
  if (Math.abs(diff) <= band) return "breakeven";

  const distToTp = Math.abs(exit - tpNum);
  const distToSl = Math.abs(exit - slNum);

  if (distToTp < distToSl) return "profit";
  if (distToSl < distToTp) return "loss";

  return diff > 0 ? "profit" : "loss";
}

/**
 * Starts the cron job. Call once at app startup.
 * Default schedule: every 2 minutes.
 */
export function startTradeStatusJob(schedule = "*/2 * * * *") {
  console.log(`[tradeStatusJob] Scheduled: ${schedule}`);
  cron.schedule(schedule, async () => {
    try {
      await processBatch();
    } catch (err) {
      console.error("[tradeStatusJob] Unhandled error in batch:", err);
    }
  });
}
