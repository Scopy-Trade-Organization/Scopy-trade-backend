import { Types } from "mongoose";

export interface LoginRequestBody {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface RegisterRequestBody {
  firstName: string;
  lastName: string;
  email: string;
  sponsored?: boolean;
  password: string;
  confirmPassword: string;
  role: "CopyTrader" | "Pro Trader";
}

// ─── Supported Exchanges ───────────────────────────────────────────────────────

export type ExchangeId = "binance" | "bybit" | "okx" | "bitget";

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
  bitget: {
    name: "Bitget",
    requiresPassphrase: true,
    fields: ["apiKey", "apiSecret", "passphrase"],
  },
};

export const PASSPHRASE_REQUIRED: ExchangeId[] = ["okx", "bitget"];

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

export interface BitgetAccountInfo {
  userId: string;
  inviterId: string;
  ips: string;
  authorities: string[];
  parentId: string;
  trader: boolean;
}

export type AccountInfo =
  | BinanceAccountInfo
  | BybitAccountInfo
  | OkxAccountInfo
  | BitgetAccountInfo;

// ─── Request Bodies ───────────────────────────────────────────────────────────

export interface ConnectExchangeBody {
  exchange: ExchangeId;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  label?: string;
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
