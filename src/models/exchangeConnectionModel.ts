import { Schema, model, InferSchemaType, HydratedDocument } from "mongoose";
import { AccountInfo, ExchangeId } from "../types/index.js";

const exchangeConnectionSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    exchange: {
      type: String,
      required: true,
      enum: ["binance", "bybit", "okx", "kucoin"] as ExchangeId[],
      lowercase: true,
    },

    label: {
      type: String,
      default: "",
      maxlength: 64,
    },

    // AES-256-GCM encrypted as "iv:authTag:ciphertext" — never returned to client
    encryptedApiKey: { type: String, default: null },
    encryptedApiSecret: { type: String, default: null },
    encryptedPassphrase: { type: String, default: null }, // OKX + KuCoin only

    // Non-sensitive snapshot of account state from the exchange
    accountInfo: {
      type: Schema.Types.Mixed,
      default: {},
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    connectedAt: { type: Date, default: Date.now },
    disconnectedAt: { type: Date, default: null },
    lastTestedAt: { type: Date, default: null },
    lastTestStatus: {
      type: String,
      enum: ["ok", "failed", null],
      default: null,
    },
  },
  { timestamps: true },
);

// One active connection per exchange per user
exchangeConnectionSchema.index(
  { userId: 1, exchange: 1, isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);

// Infer everything, then surgically replace the weak types
type RawInferred = InferSchemaType<typeof exchangeConnectionSchema>;

export type IExchangeConnection = Omit<
  RawInferred,
  "accountInfo" | "lastTestStatus"
> & {
  accountInfo: AccountInfo;
  lastTestStatus: "ok" | "failed" | null;
};

export type ExchangeConnectionDocument = HydratedDocument<IExchangeConnection>;

export const ExchangeConnection = model(
  "ExchangeConnection",
  exchangeConnectionSchema,
);
