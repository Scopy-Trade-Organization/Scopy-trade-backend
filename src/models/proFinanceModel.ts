import { Schema, model } from "mongoose";

const earningSchema = new Schema({
  tradeId: { type: Schema.Types.ObjectId, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  mode: { type: String, enum: ["live", "demo"], required: true },
  units: { type: Number, required: true, min: 0 },
}, { timestamps: true });
export const ProEarning = model("ProEarning", earningSchema);

const withdrawalSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  requestId: { type: String, required: true },
  mode: { type: String, enum: ["live", "demo"], required: true },
  units: { type: Number, required: true, min: 1 },
  address: { type: String, required: true },
  status: { type: String, enum: ["QUEUED", "SIGNED", "CONFIRMED", "FAILED", "REVIEW"], default: "QUEUED", required: true },
  transactionId: { type: String, default: null },
  signedTransaction: { type: Schema.Types.Mixed, select: false },
  expiresAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  lastError: { type: String, default: null },
}, { timestamps: true });
withdrawalSchema.index({ userId: 1, requestId: 1 }, { unique: true });
withdrawalSchema.index({ userId: 1, createdAt: -1 });
withdrawalSchema.index({ status: 1, updatedAt: 1 });
withdrawalSchema.index({ transactionId: 1 }, { unique: true, partialFilterExpression: { transactionId: { $type: "string" } } });
export const ProWithdrawal = model("ProWithdrawal", withdrawalSchema);
