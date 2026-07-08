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
    feeStatus: {
      type: String,
      enum: ["pending", "collected", "waived", null],
      default: null,
    },
  },
  { timestamps: true },
);

// Prevent duplicate trades for the same signal on the same exchange connection
tradeSchema.index({ signalId: 1, exchangeConnectionId: 1 }, { unique: true });

tradeSchema.index({ userId: 1, status: 1, createdAt: -1 });

export type ITrade = InferSchemaType<typeof tradeSchema>;
export type TradeDocument = HydratedDocument<ITrade>;

export const Trade = model<TradeDocument>("Trade", tradeSchema);
