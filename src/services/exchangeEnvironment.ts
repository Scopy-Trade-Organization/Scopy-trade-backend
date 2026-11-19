import { ExchangeId } from "../types/index.js";

export type ExchangeMode = "testnet" | "live";
export function getExchangeMode(): ExchangeMode {
  const configured = process.env.EXCHANGE_MODE?.trim().toLowerCase();
  if (configured === "live" || configured === "testnet") return configured;
  return process.env.NODE_ENV === "production" ? "live" : "testnet";
}
export const isTestnet = () => getExchangeMode() === "testnet";
function url(name: string, fallback: string) { return (process.env[name]?.trim() || fallback).replace(/\/+$/, ""); }
export function getExchangeRestUrl(exchange: ExchangeId): string {
  const prefix = exchange.toUpperCase();
  const live = { bybit: "https://api.bybit.com", okx: "https://www.okx.com", bitget: "https://api.bitget.com" }[exchange];
  const test = exchange === "bybit" ? "https://api-testnet.bybit.com" : live;
  return isTestnet() ? url(`${prefix}_TEST_API_URL`, exchange === "bybit" ? test : url(`${prefix}_API_URL`, test)) : url(`${prefix}_API_URL`, live);
}
export function getExchangeWebSocketUrl(exchange: ExchangeId): string {
  const endpoints = {
    bybit: ["wss://stream.bybit.com/v5/private", "wss://stream-testnet.bybit.com/v5/private"],
    okx: ["wss://ws.okx.com:8443/ws/v5/private", "wss://wspap.okx.com:8443/ws/v5/private"],
    bitget: ["wss://ws.bitget.com/v2/ws/private", "wss://wspap.bitget.com/v2/ws/private"],
  };
  return url(`${exchange.toUpperCase()}_${isTestnet() ? "TEST_" : ""}WS_URL`, endpoints[exchange][isTestnet() ? 1 : 0]!);
}
export function shouldRebaseTestnetSignals() { return isTestnet() && process.env.TESTNET_REBASE_SIGNAL_PRICES?.toLowerCase() !== "false"; }
export const isBitgetDemo = isTestnet;
export const isOkxDemo = isTestnet;
