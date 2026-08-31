import { ExchangeId } from "../types/index.js";

export type ExchangeMode = "testnet" | "live";

export function getExchangeMode(): ExchangeMode {
  const configured = process.env.EXCHANGE_MODE?.trim().toLowerCase();
  if (configured === "live" || configured === "testnet") return configured;
  return process.env.NODE_ENV === "production" ? "live" : "testnet";
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
      return configuredUrl("BITGET_API_URL", "https://api.bitget.com");
  }
}

export function getExchangeWebSocketUrl(
  exchange: "binance" | "bybit",
): string {
  const testnet = isTestnet();

  if (exchange === "binance") {
    return testnet
      ? configuredUrl(
          "BINANCE_FUTURES_TEST_WS_URL",
          "wss://fstream.binancefuture.com",
        )
      : configuredUrl("BINANCE_WS_URL", "wss://fstream.binance.com");
  }

  return testnet
    ? configuredUrl(
        "BYBIT_TEST_WS_URL",
        "wss://stream-testnet.bybit.com/v5/private",
      )
    : configuredUrl("BYBIT_WS_URL", "wss://stream.bybit.com/v5/private");
}

export function shouldRebaseTestnetSignals(): boolean {
  if (!isTestnet()) return false;
  return process.env.TESTNET_REBASE_SIGNAL_PRICES?.toLowerCase() !== "false";
}

// ─── Exchange demo/simulated modes ─────────────────────────────────────────────
// Bitget and OKX expose their paper-trading environments through a request
// header rather than a separate base URL, so demo selection is a header concern.
// Both helpers fail safe: OKX defaults to simulated (a real withdrawal only
// fires when OKX_DEMO_MODE is explicitly "false"), matching the previously
// hard-coded behaviour while finally making live OKX operations reachable.

export function isBitgetDemo(): boolean {
  return process.env.BITGET_DEMO_MODE === "true";
}

export function isOkxDemo(): boolean {
  return process.env.OKX_DEMO_MODE !== "false";
}
