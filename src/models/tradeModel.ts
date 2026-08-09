import { Schema, model, InferSchemaType, HydratedDocument } from "mongoose";

const tradeSchema = new Schema(
  {
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
    settlementError: { type: String, default: null },
    settlementStartedAt: { type: Date, default: null },
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
