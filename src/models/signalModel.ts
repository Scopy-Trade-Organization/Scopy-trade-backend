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
    sl: {
      type: String,
      required: true,
    },
    entry: {
      type: String,
      required: true,
    },
    signalResult: {
      type: String,
      enum: ["profit", "loss", "breakeven", null],
      default: null,
    },
  },
  { timestamps: true },
);

export type Signal = InferSchemaType<typeof signalSchema>;

export type SignalDocument = HydratedDocument<Signal>;

export const Signal = model<SignalDocument>("Signal", signalSchema);
