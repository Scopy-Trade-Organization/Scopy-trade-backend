import { Schema, model } from "mongoose";

const transactionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: ["withdrawal", "settlement"],
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
        "QUOTED",
        "PROCESSING",
        "CONFIRMED",
        "REJECTED",
        "QUEUED",
        "SIGNED",
        "COMPLETED",
        "FAILED",
        "REVIEW",
      ],
      required: true,
    },
    tradeIds: [{ type: Schema.Types.ObjectId, ref: "Trade" }],
    requestId: { type: String, trim: true },
    address: { type: String },
    memo: { type: String },
    transactionId: { type: String },
    senderAddress: { type: String },
    completedAt: { type: Date },
    lastError: { type: String },
    // Settlement invoices and permanent hash claims share this collection.
    settlementRecordKind: { type: String, enum: ["invoice", "payment"] },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Transaction" },
    network: { type: String, enum: ["TRON"] },
    transactionHash: {
      type: String,
      lowercase: true,
      trim: true,
      match: /^[a-f0-9]{64}$/,
    },
    claimToken: String,
    leaseUntil: Date,
    retryable: Boolean,
    confirmedAt: Date,
    scanFingerprint: String,
    scanMinTimestamp: Number,
    scanMaxTimestamp: Number,
    scanLeaseUntil: Date,
    scanToken: String,
    // Saved before broadcasting so a retry sends the same payout, never a second one.
    signedTransaction: { type: Schema.Types.Mixed, select: false },
    expiresAt: { type: Date },
    // Withdrawal units are the user's total reservation; only payoutUnits is sent.
    payoutUnits: { type: Number, min: 1, validate: Number.isSafeInteger },
    networkFeeReserveUnits: {
      type: Number,
      min: 0,
      validate: Number.isSafeInteger,
    },
    networkFeeUnits: { type: Number, min: 0, validate: Number.isSafeInteger },
    networkFeeSun: { type: Number, min: 0, validate: Number.isSafeInteger },
    feeLimitSun: { type: Number, min: 1, validate: Number.isSafeInteger },
    bandwidthSunPerByte: {
      type: Number,
      min: 1,
      validate: Number.isSafeInteger,
    },
    trxPriceUnits: { type: Number, min: 1, validate: Number.isSafeInteger },
    quoteExpiresAt: Date,
    refundUnits: { type: Number, min: 0, validate: Number.isSafeInteger },
    feeOverrunUnits: { type: Number, min: 0, validate: Number.isSafeInteger },
  },
  { timestamps: true, collection: "transactions" },
);

transactionSchema.index({ userId: 1, type: 1, createdAt: -1 });
transactionSchema.index({ type: 1, status: 1, updatedAt: 1 });
transactionSchema.index(
  { type: 1, userId: 1, requestId: 1 },
  { unique: true, partialFilterExpression: { requestId: { $type: "string" } } },
);
// No TTL: confirmed settlement hash claims must be retained permanently.
transactionSchema.index(
  { network: 1, transactionHash: 1 },
  {
    unique: true,
    name: "unique_network_payment_hash",
    partialFilterExpression: { transactionHash: { $type: "string" } },
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
  {
    name: "unique_transaction_memo",
    unique: true,
    partialFilterExpression: { memo: { $type: "string" } },
  },
);
transactionSchema.index(
  { tradeIds: 1 },
  {
    name: "unique_settlement_per_trade",
    unique: true,
    partialFilterExpression: {
      type: "settlement",
      "tradeIds.0": { $exists: true },
    },
  },
);

export const Transaction = model("Transaction", transactionSchema);
