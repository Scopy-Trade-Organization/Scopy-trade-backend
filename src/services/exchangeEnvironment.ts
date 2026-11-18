import { ExchangeId } from "../types/index.js";

export type ExchangeMode = "testnet" | "live";

/**
 * Returns the current exchange mode.
 * Safe default: Only explicitly setting EXCHANGE_MODE=live enables real-money live trading.
 * If EXCHANGE_MODE is unset, empty, or set to anything other than "live", "testnet" is used.
 * This prevents accidental real-money trading when configuration is missing.
 */
export function getExchangeMode(): ExchangeMode {
  const configured = process.env.EXCHANGE_MODE?.trim().toLowerCase();
  if (configured === "live") return "live";
  return "testnet";
}

export function isTestnet(): boolean {
  return getExchangeMode() === "testnet";
}

function configuredUrl(name: string, fallback: string): string {
  return (process.env[name]?.trim() || fallback).replace(/\/+$/, "");
}

export function getExchangeRestUrl(exchange: ExchangeId): string {
  const testnet = isTestnet();

  switch (exchange) {
    case "binance":
      return testnet
        ? configuredUrl(
            "BINANCE_FUTURES_TEST_API_URL",
            "https://testnet.binancefuture.com",
          )
        : configuredUrl("BINANCE_API_URL", "https://fapi.binance.com");
    case "bybit":
      return testnet
        ? configuredUrl("BYBIT_TEST_API_URL", "https://api-testnet.bybit.com")
        : configuredUrl("BYBIT_API_URL", "https://api.bybit.com");
    case "okx":
      return configuredUrl("OKX_API_URL", "https://www.okx.com");
    case "bitget":
      return configuredUrl(
        "BITGET_API_URL",
        process.env.BITGET_BASE_URL?.trim() || "https://api.bitget.com",
      );
  }
}

export function getExchangeWebSocketUrl(exchange: ExchangeId): string {
  const testnet = isTestnet();

  switch (exchange) {
    case "binance":
      return testnet
        ? configuredUrl(
            "BINANCE_FUTURES_TEST_WS_URL",
            "wss://fstream.binancefuture.com",
          )
        : configuredUrl("BINANCE_WS_URL", "wss://fstream.binance.com");
    case "bybit":
      return testnet
        ? configuredUrl(
            "BYBIT_TEST_WS_URL",
            "wss://stream-testnet.bybit.com/v5/private",
          )
        : configuredUrl("BYBIT_WS_URL", "wss://stream.bybit.com/v5/private");
    case "bitget":
      return configuredUrl(
        "BITGET_WS_URL",
        "wss://ws.bitget.com/v2/ws/private",
      );
    case "okx":
      return configuredUrl("OKX_WS_URL", "wss://ws.okx.com:8443/ws/v5/private");
  }
}

export function shouldRebaseTestnetSignals(): boolean {
  if (!isTestnet()) return false;
  return process.env.TESTNET_REBASE_SIGNAL_PRICES?.toLowerCase() !== "false";
}

// ─── Exchange demo/simulated modes ─────────────────────────────────────────────
// Bitget and OKX expose paper-trading environments through request headers
// rather than a separate base URL, so demo selection is a header concern.
// Both helpers fail safe:
// - OKX defaults to simulated (a real withdrawal/trade only fires when OKX_DEMO_MODE is "false").
// - Bitget uses BITGET_DEMO_MODE override if provided; otherwise falls back to isTestnet().

export function isBitgetDemo(): boolean {
  const demoOverride = process.env.BITGET_DEMO_MODE?.trim().toLowerCase();
  if (demoOverride === "true") return true;
  if (demoOverride === "false") return false;
  return isTestnet();
}

export function isOkxDemo(): boolean {
  return process.env.OKX_DEMO_MODE !== "false";
}
