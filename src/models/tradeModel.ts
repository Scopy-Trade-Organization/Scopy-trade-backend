import { Schema, model, InferSchemaType, HydratedDocument } from "mongoose";
import { randomUUID } from "node:crypto";

export const createTradeId = () =>
  `SCT-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;

const tradeSchema = new Schema(
  {
    tradeId: {
      type: String,
      default: createTradeId,
      unique: true,
      sparse: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    pair: {
      type: String,
      required: true,
    },
    tp: {
      type: String,
      required: true,
    },
    sl: {
      type: String,
      required: true,
    },
    signalId: {
      type: Schema.Types.ObjectId,
      ref: "Signal",
      required: true,
    },
    tradeOrigin: {
      type: String,
      enum: ["pro", "copy"],
      default: "copy",
      required: true,
      index: true,
    },
    sourceTradeId: {
      type: Schema.Types.ObjectId,
      ref: "Trade",
      default: null,
      index: true,
    },
    // References ExchangeConnection, not a raw exchange name
    exchangeConnectionId: {
      type: Schema.Types.ObjectId,
      ref: "ExchangeConnection",
      required: true,
    },
    // The exchange-native order ID returned at placement
    exchangeOrderId: {
      type: String,
      default: null,
    },
    // Stable client-generated ID used to correlate exchange child/TP/SL orders.
    exchangeClientOrderId: {
      type: String,
      default: null,
    },
    exchangeProtectionOrderIds: {
      type: [String],
      default: [],
    },
    exchangeProtectionOrderTransport: {
      type: String,
      enum: ["algo", "legacy", null],
      default: null,
    },
    direction: {
      type: String,
      enum: ["buy", "sell"],
      required: true,
    },
    quantity: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "filled", "closed", "cancelled", "failed"],
      default: "pending",
      index: true,
    },
    entryPrice: {
      type: String,
      required: true,
    },
    entryFillPrice: {
      type: String,
      default: null,
    },
    exitPrice: {
      type: String,
      default: null,
    },
    tradeResult: {
      type: String,
      enum: ["profit", "loss", "breakeven", null],
      default: null,
    },
    // Raw response snapshot from the exchange at order placement
    rawOrderResponse: {
      type: Schema.Types.Mixed,
      default: null,
    },
    // Last status check snapshot from the exchange
    lastCheckedAt: {
      type: Date,
      default: null,
    },
    rawStatusResponse: {
      type: Schema.Types.Mixed,
      default: null,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    // ─── Trade Monitoring ─────────────────────────────────────────────────────
    wsMonitoringActive: {
      type: Boolean,
      default: false,
    },
    monitoringStatus: {
      type: String,
      enum: [
        "connecting",
        "connected",
        "reconnecting",
        "disconnected",
        "unsupported",
      ],
      default: "disconnected",
      index: true,
    },
    monitoringError: {
      type: String,
      default: null,
    },
    monitoringConnectedAt: {
      type: Date,
      default: null,
    },
    // How the trade was closed (TP hit, SL hit, or manual)
    closedVia: {
      type: String,
      enum: ["tp", "sl", "manual", null],
      default: null,
    },
    // ─── Profit Sharing ───────────────────────────────────────────────────────
    realizedPnl: {
      type: String,
      default: null,
    },
    platformFee: {
      type: String,
      default: null,
    },
    platformShare: {
      type: String,
      default: null,
    },
    proTraderShare: {
      type: String,
      default: null,
    },
    feeStatus: {
      type: String,
      enum: ["pending", "processing", "collected", "failed", "waived", null],
      default: null,
    },
    settlementNetwork: { type: String, default: null },
    settlementAddress: { type: String, default: null },
    settlementTransactionId: { type: String, default: null },
    settlementBlockchainTransactionId: { type: String, default: null },
    settlementError: { type: String, default: null },
    settlementStartedAt: { type: Date, default: null },
    settlementBatchId: { type: String, default: null, index: true },
    settlementCompletedAt: { type: Date, default: null },
    proTraderCreditStatus: {
      type: String,
      enum: ["pending", "credited", "waived", null],
      default: null,
    },
    proTraderCreditedAt: { type: Date, default: null },
    parameterSyncStatus: {
      type: String,
      enum: ["pending", "synced", "failed", null],
      default: null,
    },
    parameterSyncError: { type: String, default: null },
    parameterSyncedAt: { type: Date, default: null },
    // Set when the source pro trade has been closed but this copied order could not be closed automatically.
    sourceTradeClosedAt: { type: Date, default: null },
    sourceTradeCloseMessage: { type: String, default: null },
  },
  { timestamps: true },
);

// Prevent duplicate trades for the same signal on the same exchange connection
tradeSchema.index({ signalId: 1, exchangeConnectionId: 1 }, { unique: true });

tradeSchema.index(
  { sourceTradeId: 1, exchangeConnectionId: 1 },
  {
    unique: true,
    partialFilterExpression: { sourceTradeId: { $type: "objectId" } },
  },
);

tradeSchema.index({ userId: 1, status: 1, createdAt: -1 });

export type ITrade = InferSchemaType<typeof tradeSchema>;
export type TradeDocument = HydratedDocument<ITrade>;

export const Trade = model<TradeDocument>("Trade", tradeSchema);

export async function backfillMissingTradeIds(): Promise<void> {
  while (true) {
    const trades = await Trade.find({
      $or: [
        { tradeId: { $exists: false } },
        { tradeId: null },
        { tradeId: "" },
      ],
    }).select("_id").limit(500).lean();
    if (!trades.length) return;
    await Trade.bulkWrite(
      trades.map((trade) => ({
        updateOne: {
          filter: { _id: trade._id, $or: [{ tradeId: { $exists: false } }, { tradeId: null }, { tradeId: "" }] },
          update: { $set: { tradeId: createTradeId() } },
        },
      })),
      { ordered: false },
    );
  }
}
