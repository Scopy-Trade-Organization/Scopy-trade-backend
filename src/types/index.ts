import { Request } from "express";
import { Types } from "mongoose";

// ─── Supported Exchanges ───────────────────────────────────────────────────────

export type ExchangeId = "binance" | "bybit" | "okx" | "kucoin";

export interface ExchangeMeta {
  name: string;
  requiresPassphrase: boolean;
  fields: string[];
}

export const SUPPORTED_EXCHANGES: Record<ExchangeId, ExchangeMeta> = {
  binance: {
    name: "Binance",
    requiresPassphrase: false,
    fields: ["apiKey", "apiSecret"],
  },
  bybit: {
    name: "Bybit",
    requiresPassphrase: false,
    fields: ["apiKey", "apiSecret"],
  },
  okx: {
    name: "OKX",
    requiresPassphrase: true,
    fields: ["apiKey", "apiSecret", "passphrase"],
  },
  kucoin: {
    name: "KuCoin",
    requiresPassphrase: true,
    fields: ["apiKey", "apiSecret", "passphrase"],
  },
};

export const PASSPHRASE_REQUIRED: ExchangeId[] = ["okx", "kucoin"];

// ─── Credentials ──────────────────────────────────────────────────────────────

export interface RawCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
}

export interface EncryptedCredentials {
  exchange: ExchangeId;
  apiKey: string; // "iv:authTag:ciphertext"
  apiSecret: string;
  passphrase?: string;
}

// ─── Exchange Account Info (returned after validation) ────────────────────────

export interface BinanceAccountInfo {
  accountType: string;
  canTrade: boolean;
  canWithdraw: boolean;
  permissions: string[];
}

export interface BybitAccountInfo {
  accountType: string;
  permissions: Record<string, string[]>;
  readOnly: boolean;
}

export interface OkxAccountInfo {
  accountLevel: string;
  posMode: string;
  uid: string;
}

export interface KucoinAccountInfo {
  accounts: Array<{
    currency: string;
    balance: string;
    type: string;
  }>;
}

export type AccountInfo =
  | BinanceAccountInfo
  | BybitAccountInfo
  | OkxAccountInfo
  | KucoinAccountInfo;

// ─── Request Bodies ───────────────────────────────────────────────────────────

export interface ConnectExchangeBody {
  exchange: ExchangeId;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  label?: string;
}

// ─── Authenticated Request ────────────────────────────────────────────────────

export interface JwtPayload {
  id: string;
  email: string;
}

export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

// ─── API Responses ────────────────────────────────────────────────────────────

export interface ApiResponse<T = undefined> {
  success: boolean;
  message?: string;
  data?: T;
}

export interface ExchangeListItem extends ExchangeMeta {
  id: ExchangeId;
  connected: boolean;
}

export interface ConnectionSummary {
  id: Types.ObjectId;
  exchange: ExchangeId;
  label: string;
  accountInfo: AccountInfo;
  connectedAt: Date;
  lastTestedAt?: Date | null;
  lastTestStatus?: "ok" | "failed" | null;
}
