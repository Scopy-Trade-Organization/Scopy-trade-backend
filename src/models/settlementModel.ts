import { Schema, model, InferSchemaType, HydratedDocument } from "mongoose";

const settlementSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    exchangeConnectionId: {
      type: Schema.Types.ObjectId,
      ref: "ExchangeConnection",
      required: true,
    },
    requestId: { type: String, required: true, trim: true },
    batchId: { type: String, required: true, index: true },
    tradeIds: [{ type: Schema.Types.ObjectId, ref: "Trade", required: true }],
    amount: { type: String, required: true },
    exchange: { type: String, enum: ["binance", "bybit", "okx", "bitget"], required: true },
    network: { type: String, required: true },
    destinationAddress: { type: String, required: true },
    status: {
      type: String,
      enum: ["PROCESSING", "SUBMITTED", "COMPLETED", "FAILED"],
      required: true,
      default: "PROCESSING",
      index: true,
    },
    simulated: { type: Boolean, default: false },
    accountType: { type: String, default: null },
    availableUsdt: { type: String, default: null },
    withdrawalId: { type: String, default: null },
    blockchainTransactionId: { type: String, default: null },
    error: { type: String, default: null },
    submittedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

settlementSchema.index({ userId: 1, requestId: 1 }, { unique: true });
settlementSchema.index({ createdAt: -1 });

export type ISettlement = InferSchemaType<typeof settlementSchema>;
export type SettlementDocument = HydratedDocument<ISettlement>;
export const Settlement = model<SettlementDocument>("Settlement", settlementSchema);
