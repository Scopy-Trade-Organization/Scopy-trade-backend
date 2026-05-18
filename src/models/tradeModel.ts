import { Schema, model, InferSchemaType, HydratedDocument } from "mongoose";

const tradeSchema = new Schema(
  {
    pair: {
      type: String,
      required: true,
    },
    tp: {
      type: String,
      required: true,
    },
    signalId: {
      type: Schema.Types.ObjectId,
      ref: "Signal",
      required: true,
    },
    exchangeId: {
      type: Schema.Types.ObjectId,
      ref: "Exchange",
      required: true,
    },
    status: {
      type: String,
      enum: ["open", "closed", "cancelled"],
      default: "open",
    },
    entryPrice: {
      type: String,
      required: true,
    },
    exitPrice: {
      type: String,
      default: null,
    },
    tradeResult: {
      type: String,
      enum: ["profit", "loss", "breakeven", null],
      default: null,
    },
  },
  { timestamps: true },
);
