import { ExchangeId } from "./types/index.js";

// ─── Supported Trading Pairs ────────────────────────────────────────────────
// Only these pairs are enabled for development and testing.
export const SUPPORTED_PAIRS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "BNBUSDT",
  "SUIUSDT",
] as const;
export type SupportedPair = (typeof SUPPORTED_PAIRS)[number];

// ─── Supported Exchanges for Trading ────────────────────────────────────────
export const SUPPORTED_TRADE_EXCHANGES: ExchangeId[] = ["bybit", "okx", "bitget"];

// ─── Risk Management ───────────────────────────────────────────────────────
// Maximum percentage of available balance at risk per trade.
export const MAX_RISK_PERCENT = 0.02;

// Maximum allowed deviation between signal entry price and current market price.
export const DEFAULT_MAX_ENTRY_DEVIATION = 0.02;

// ─── Platform Fees ──────────────────────────────────────────────────────────
// Percentage of realized profit taken as platform fee.
export const PLATFORM_FEE_PERCENT = 0.20;
export const PLATFORM_SHARE_PERCENT = 0.15;
export const PRO_TRADER_SHARE_PERCENT = 0.05;
