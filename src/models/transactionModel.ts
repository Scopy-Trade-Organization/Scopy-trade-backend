import { Schema, model } from "mongoose";

const transactionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: ["earning", "withdrawal", "settlement"],
      required: true,
    },
    // USDT micro-units (1 USDT = 1,000,000 units).
    units: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
    status: {
      type: String,
      enum: [
        "AWAITING_PAYMENT",
        "QUEUED",
        "SIGNED",
        "COMPLETED",
        "FAILED",
        "REVIEW",
      ],
      required: true,
    },
    tradeId: { type: Schema.Types.ObjectId, ref: "Trade" },
    tradeIds: [{ type: Schema.Types.ObjectId, ref: "Trade" }],
    requestId: { type: String, trim: true },
    address: { type: String },
    memo: { type: String },
    transactionId: { type: String },
    senderAddress: { type: String },
    completedAt: { type: Date },
    lastError: { type: String },
    // Saved before broadcasting so a retry sends the same payout, never a second one.
    signedTransaction: { type: Schema.Types.Mixed, select: false },
    expiresAt: { type: Date },
  },
  { timestamps: true, collection: "transactions" },
);

transactionSchema.index({ userId: 1, type: 1, createdAt: -1 });
transactionSchema.index({ type: 1, status: 1, updatedAt: 1 });
transactionSchema.index(
  { type: 1, userId: 1, requestId: 1 },
  { unique: true, partialFilterExpression: { requestId: { $type: "string" } } },
);
transactionSchema.index(
  { type: 1, tradeId: 1 },
  {
    name: "unique_earning_per_trade",
    unique: true,
    partialFilterExpression: {
      type: "earning",
      tradeId: { $type: "objectId" },
    },
  },
);
transactionSchema.index(
  { transactionId: 1 },
  {
    unique: true,
    partialFilterExpression: { transactionId: { $type: "string" } },
  },
);
transactionSchema.index(
  { userId: 1 },
  {
    name: "unique_open_settlement_per_user",
    unique: true,
    partialFilterExpression: { type: "settlement", status: "AWAITING_PAYMENT" },
  },
);
transactionSchema.index(
  { memo: 1 },
  { name: "unique_transaction_memo", unique: true, partialFilterExpression: { memo: { $type: "string" } } },
);

export const Transaction = model("Transaction", transactionSchema);
