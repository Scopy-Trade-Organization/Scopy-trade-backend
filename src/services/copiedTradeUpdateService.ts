import { Trade } from "../models/tradeModel.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import { amendTradeOrder, closeTradeOrder, getOrderStatus } from "./tradeService.js";
import { decryptCredentials } from "./exchangeConnectionService.js";
import { getTradeMonitorService } from "./tradeMonitorService.js";
import { ExchangeId } from "../types/index.js";
import { processTradeClose } from "./profitSharingService.js";

interface ProtectionUpdate {
  tp: string;
  sl: string;
}

async function updateOneCopiedTrade(tradeId: string, parameters: ProtectionUpdate): Promise<void> {
  const trade = await Trade.findOne({
    _id: tradeId,
    tradeOrigin: "copy",
    status: { $in: ["pending", "filled"] },
  });
  if (!trade?.exchangeOrderId) return;

  await Trade.updateOne(
    { _id: tradeId },
    { $set: { parameterSyncStatus: "pending", parameterSyncError: null } },
  );

  try {
    const connection = await ExchangeConnection.findOne({
      _id: trade.exchangeConnectionId,
      isActive: true,
    }).lean();
    if (!connection?.encryptedApiKey || !connection.encryptedApiSecret) {
      throw new Error("Exchange connection unavailable.");
    }
    const exchange = connection.exchange as ExchangeId;
    const credentials = decryptCredentials({
      exchange,
      apiKey: connection.encryptedApiKey,
      apiSecret: connection.encryptedApiSecret,
      ...(connection.encryptedPassphrase
        ? { passphrase: connection.encryptedPassphrase }
        : {}),
    });
    const live = await getOrderStatus(exchange, credentials, trade.pair, trade.exchangeOrderId);
    if (!["pending", "filled"].includes(live.status)) return;

    const amended = await amendTradeOrder(exchange, {
      credentials,
      pair: trade.pair,
      direction: trade.direction as "buy" | "sell",
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
      tp: parameters.tp,
      sl: parameters.sl,
      orderId: trade.exchangeOrderId,
      status: live.status as "pending" | "filled",
      entryChanged: false,
      protectionChanged: parameters.tp !== trade.tp || parameters.sl !== trade.sl,
      protectionOrderIds: trade.exchangeProtectionOrderIds,
      ...(trade.exchangeProtectionOrderTransport !== undefined
        ? { protectionTransport: trade.exchangeProtectionOrderTransport }
        : {}),
    });

    trade.tp = amended.tp;
    trade.sl = amended.sl;
    if (amended.orderId) trade.exchangeOrderId = amended.orderId;
    if (amended.protectionOrderIds) {
      trade.exchangeProtectionOrderIds = amended.protectionOrderIds;
      trade.exchangeProtectionOrderTransport = amended.protectionTransport ?? "algo";
    }
    trade.parameterSyncStatus = "synced";
    trade.parameterSyncError = null;
    trade.parameterSyncedAt = new Date();
    await trade.save();

    const monitor = getTradeMonitorService();
    await monitor.stopMonitoring(String(trade._id));
    await monitor.startMonitoring(String(trade._id));
    monitor.emit("tradeUpdate", {
      tradeId: String(trade._id),
      exchangeOrderId: trade.exchangeOrderId,
      status: trade.status,
      tp: trade.tp,
      sl: trade.sl,
      timestamp: new Date(),
    });
  } catch (error) {
    await Trade.updateOne(
      { _id: tradeId },
      {
        $set: {
          parameterSyncStatus: "failed",
          parameterSyncError: error instanceof Error ? error.message : String(error),
        },
      },
    );
    throw error;
  }
}

/** Runs detached from the HTTP request; each copied order is isolated. */
export async function updateCopiedTrades(
  sourceTradeId: string,
  parameters: ProtectionUpdate,
): Promise<void> {
  const copies = await Trade.find({
    sourceTradeId,
    tradeOrigin: "copy",
    status: { $in: ["pending", "filled"] },
  })
    .select("_id")
    .lean();

  const batchSize = 5;
  for (let index = 0; index < copies.length; index += batchSize) {
    const batch = copies.slice(index, index + batchSize);
    const results = await Promise.allSettled(
      batch.map((copy) => updateOneCopiedTrade(String(copy._id), parameters)),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[copiedTradeUpdateService] Copy update failed:", result.reason);
      }
    }
  }
}

export function queueCopiedTradeUpdate(
  sourceTradeId: string,
  parameters: ProtectionUpdate,
): void {
  setImmediate(() => {
    void updateCopiedTrades(sourceTradeId, parameters).catch((error) => {
      console.error(`[copiedTradeUpdateService] Propagation failed for ${sourceTradeId}:`, error);
    });
  });
}

async function closeOneCopiedTrade(tradeId: string): Promise<void> {
  const trade = await Trade.findOne({
    _id: tradeId,
    tradeOrigin: "copy",
    status: { $in: ["pending", "filled"] },
  });
  if (!trade?.exchangeOrderId) throw new Error("Copied trade has no exchange order to close.");

  const connection = await ExchangeConnection.findOne({
    _id: trade.exchangeConnectionId,
    isActive: true,
  }).lean();
  if (!connection?.encryptedApiKey || !connection.encryptedApiSecret) {
    throw new Error("The copy trader's exchange connection is unavailable.");
  }
  const exchange = connection.exchange as ExchangeId;
  const credentials = decryptCredentials({
    exchange,
    apiKey: connection.encryptedApiKey,
    apiSecret: connection.encryptedApiSecret,
    ...(connection.encryptedPassphrase ? { passphrase: connection.encryptedPassphrase } : {}),
  });
  const closed = await closeTradeOrder(exchange, {
    credentials,
    pair: trade.pair,
    direction: trade.direction as "buy" | "sell",
    quantity: trade.quantity,
    orderId: trade.exchangeOrderId,
    status: trade.status as "pending" | "filled",
  });

  const monitor = getTradeMonitorService();
  await monitor.stopMonitoring(String(trade._id));
  if (closed.status === "cancelled") {
    await Trade.updateOne(
      { _id: trade._id },
      { $set: { status: "cancelled", closedAt: new Date(), closedVia: "manual", sourceTradeClosedAt: null, sourceTradeCloseMessage: null } },
    );
  } else {
    await processTradeClose(String(trade._id), closed.exitPrice || trade.entryFillPrice || trade.entryPrice, "manual");
  }
  monitor.emit("tradeUpdate", {
    tradeId: String(trade._id),
    status: closed.status,
    sourceTradeClosedAt: null,
    timestamp: new Date(),
  });
}

/** Starts after a pro closes. It is intentionally fire-and-forget: no queue or worker is involved. */
export function triggerCopiedTradeClosures(sourceTradeId: string): void {
  void (async () => {
    const sourceClosedAt = new Date();
    await Trade.updateMany(
      { sourceTradeId, tradeOrigin: "copy", status: { $in: ["pending", "filled"] } },
      { $set: { sourceTradeClosedAt: sourceClosedAt, sourceTradeCloseMessage: "The pro trader has closed this trade. Close it manually if it remains open." } },
    );
    const copies = await Trade.find({
      sourceTradeId,
      tradeOrigin: "copy",
      status: { $in: ["pending", "filled"] },
    }).select("_id").lean();
    await Promise.all(copies.map(async (copy) => {
      try {
        await closeOneCopiedTrade(String(copy._id));
      } catch (error) {
        console.error(`[copiedTradeUpdateService] Failed to close copied trade ${copy._id}:`, error);
      }
    }));
  })().catch((error) => {
    console.error(`[copiedTradeUpdateService] Failed to start copied-trade closures for ${sourceTradeId}:`, error);
  });
}
