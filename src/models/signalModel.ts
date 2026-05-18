import { Schema, model, InferSchemaType, HydratedDocument } from "mongoose";

const signalSchema = new Schema(
  {
    symbol: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ["BUY", "SELL"],
      required: true,
    },
    entryPrice: {
      type: Number,
      required: true,
    },
    targetPrice: {
      type: Number,
    },
    stopLoss: {
      type: Number,
    },
    status: {
      type: String,
      enum: ["ACTIVE", "CLOSED"],
      default: "ACTIVE",
    },
  },
  { timestamps: true }
);

export type Signal = InferSchemaType<typeof signalSchema>;
export type SignalDocument = HydratedDocument<Signal>;
const Signal = model("Signal", signalSchema);

export default Signal;
