import { Schema, model, Document, Types } from "mongoose";
import { ExchangeId, AccountInfo } from "../types/index.js";

// ─── Document Interface ───────────────────────────────────────────────────────

export interface IExchangeConnection extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  exchange: ExchangeId;
  label: string;
  encryptedApiKey: string | null;
  encryptedApiSecret: string | null;
  encryptedPassphrase: string | null;
  accountInfo: AccountInfo;
  isActive: boolean;
  connectedAt: Date;
  disconnectedAt: Date | null;
  lastTestedAt: Date | null;
  lastTestStatus: "ok" | "failed" | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const exchangeConnectionSchema = new Schema<IExchangeConnection>(
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

export const ExchangeConnection = model<IExchangeConnection>(
  "ExchangeConnection",
  exchangeConnectionSchema,
);
