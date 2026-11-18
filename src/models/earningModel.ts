import { Schema, model } from "mongoose";

const earningSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  tradeId: { type: Schema.Types.ObjectId, ref: "Trade", required: true },
  units: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  status: { type: String, enum: ["COMPLETED"], required: true },
  completedAt: Date,
}, { timestamps: true, collection: "earnings" });

earningSchema.index({ tradeId: 1 }, { unique: true, name: "unique_earning_per_trade" });
earningSchema.index({ userId: 1, createdAt: -1 });
export const Earning = model("Earning", earningSchema);
