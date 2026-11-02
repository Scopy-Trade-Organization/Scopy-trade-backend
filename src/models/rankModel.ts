import { Schema, model } from "mongoose";

const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  level: { type: Number, required: true, min: 1, max: 5 },
  bonus: { type: Number, required: true },
  status: { type: String, enum: ["pending", "credited"], default: "pending", required: true },
  qualifiedMetrics: { type: Schema.Types.Mixed, required: true },
  verifiedBy: { type: Schema.Types.ObjectId, ref: "Admin", default: null },
  verifiedAt: { type: Date, default: null },
  mode: { type: String, enum: ["demo", "live", null], default: null },
}, { timestamps: true });
schema.index({ userId: 1, level: 1 }, { unique: true });
export const RankAward = model("RankAward", schema);
