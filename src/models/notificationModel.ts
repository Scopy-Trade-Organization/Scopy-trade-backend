import { Schema, model } from "mongoose";

const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  kind: { type: String, enum: ["copy_failure", "settlement_due", "settlement_paid"], default: "copy_failure" },
  executionId: { type: Schema.Types.ObjectId, ref: "CopyExecution" },
  settlementId: { type: Schema.Types.ObjectId, ref: "Transaction" },
  title: { type: String, required: true },
  message: { type: String, required: true },
  href: { type: String, default: "/dashboard/copy-trader" },
  readAt: { type: Date, default: null },
  emailSentAt: { type: Date, default: null },
  emailLeaseUntil: { type: Date, default: null },
  emailLastError: { type: String, default: null },
}, { timestamps: true });
schema.index({ userId: 1, readAt: 1, createdAt: -1 });
schema.index({ executionId: 1 }, { unique: true, partialFilterExpression: { executionId: { $type: "objectId" } } });
schema.index({ settlementId: 1, kind: 1 }, { unique: true, partialFilterExpression: { settlementId: { $type: "objectId" } } });
export const Notification = model("Notification", schema);
