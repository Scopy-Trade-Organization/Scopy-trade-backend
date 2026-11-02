import { Schema, model } from "mongoose";

const schema = new Schema({
  copierId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  proTraderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  exchangeConnectionId: { type: Schema.Types.ObjectId, ref: "ExchangeConnection", required: true },
  allocation: { type: Number, required: true, min: 1 },
  active: { type: Boolean, default: true, required: true },
  startedAt: { type: Date, default: Date.now, required: true },
  stoppedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ copierId: 1, proTraderId: 1 }, { unique: true });
schema.index({ proTraderId: 1, active: 1 });
export const CopySubscription = model("CopySubscription", schema);

const executionSchema = new Schema({
  subscriptionId: { type: Schema.Types.ObjectId, ref: "CopySubscription", required: true },
  sourceTradeId: { type: Schema.Types.ObjectId, ref: "Trade", required: true },
  copierId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  exchangeConnectionId: { type: Schema.Types.ObjectId, ref: "ExchangeConnection", required: true },
  status: { type: String, enum: ["queued", "processing", "completed", "failed", "skipped"], default: "queued", required: true },
  reason: { type: String, default: null },
  startedAt: { type: Date, default: null },
  availableAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
  failureNotifiedAt: { type: Date, default: null },
}, { timestamps: true });
executionSchema.index({ sourceTradeId: 1, exchangeConnectionId: 1 }, { unique: true });
executionSchema.index({ status: 1, createdAt: 1 });
executionSchema.index({ status: 1, failureNotifiedAt: 1 });
export const CopyExecution = model("CopyExecution", executionSchema);

const notificationSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  executionId: { type: Schema.Types.ObjectId, ref: "CopyExecution", required: true, unique: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  readAt: { type: Date, default: null },
}, { timestamps: true });
export const CopyNotification = model("CopyNotification", notificationSchema);

// No automatic expiry: a crashed exchange request must be reconciled before reuse.
const lockSchema = new Schema({
  connectionId: { type: Schema.Types.ObjectId, required: true, unique: true },
  executionId: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });
export const CopyExecutionLock = model("CopyExecutionLock", lockSchema);
