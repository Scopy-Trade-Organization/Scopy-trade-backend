import { Schema, model, InferSchemaType, HydratedDocument } from "mongoose";

const signalSchema = new Schema(
  {
    pair: {
      type: String,
      required: true,
    },
    tp: {
      type: String,
      required: true,
    },
    trader: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    sl: {
      type: String,
      required: true,
    },
    direction: {
      type: String,
      enum: ["buy", "sell"],
      required: true,
    },
    entry: {
      type: String,
      required: true,
    },
    notes: {
      type: String,
    },
    signalResult: {
      type: String,
      enum: ["profit", "loss", "breakeven", null],
      default: null,
    },
    status: {
      type: String,
      enum: ["active", "expired"],
      default: "active",
    },
  },
  { timestamps: true },
);

export type ISignal = InferSchemaType<typeof signalSchema>;

export type SignalDocument = HydratedDocument<ISignal>;

export const Signal = model<SignalDocument>("Signal", signalSchema);
