import type { ExchangeRequest } from "./exchangeApiService.js";
import { decimal, TradeRiskError } from "./tradeRiskService.js";

export const BITGET_CATEGORY = "USDT-FUTURES";
export const BITGET_ORDER_SUBSCRIPTION = { instType: "UTA", topic: "order" } as const;

export function bitgetList(value: unknown, name: string): any[] {
  if (!Array.isArray(value)) throw new TradeRiskError("INVALID_EXCHANGE_RESPONSE", `Bitget UTA ${name} could not be verified.`);
  return value;
}

/** Bitget can return list:null for an empty, successful position lookup. */
export function bitgetPositions(response: any): any[] {
  const data = response?.data;
  const rows = Array.isArray(data) ? data : data?.list;
  const noMoreData = [data?.cursor, data?.endId, response?.cursor, response?.endId]
    .every(value => value === undefined || value === null || value === "");
  if (response?.code === "00000" && rows === null && data?.list === null && noMoreData) return [];
  if (!Array.isArray(rows)) {
    const type = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    console.warn("[bitgetUta] Invalid position response shape", {
      endpoint: "/api/v3/position/current-position",
      dataType: type(data), listType: type(data?.list),
    });
    throw new TradeRiskError("INVALID_EXCHANGE_RESPONSE", "Bitget UTA positions could not be verified.");
  }
  return rows;
}

/** UTA strategy reads cover the whole category; callers must filter by symbol. */
export async function bitgetStrategies(api: ExchangeRequest, symbol: string, type?: string) {
  const result = await api("GET", "/api/v3/trade/unfilled-strategy-orders", {
    category: BITGET_CATEGORY, ...(type ? { type } : {}),
  });
  return bitgetList(result.data, "strategy orders").filter(r => r.symbol === symbol && r.category === BITGET_CATEGORY);
}

export async function bitgetOrderHistory(api: ExchangeRequest, symbol: string, opened: number) {
  const rows: any[] = [];
  const cursors = new Set<string>();
  const endTime = String(Date.now());
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await api("GET", "/api/v3/trade/history-orders", {
      symbol, category: BITGET_CATEGORY, startTime: String(opened), endTime, limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...bitgetList(result.data?.list, "order history"));
    const next = result.data?.cursor;
    if (!next) return rows;
    if (typeof next !== "string" || cursors.has(next)) break;
    cursors.add(next);
    cursor = next;
  }
  throw new TradeRiskError("ORDER_REVIEW_REQUIRED", "Bitget UTA order history is incomplete. The actual exit requires review.");
}

export function assertBitgetAccountSettings(data: any) {
  if (!data || !["unified", "hybrid"].includes(data.accountMode) ||
      !["isolated", "basic", "advanced"].includes(data.accountLevel) || data.holdMode !== "one_way_mode" || data.deltaSwitch !== "no") {
    throw new TradeRiskError("UNSUPPORTED_ACCOUNT_MODE", "Bitget UTA requires a supported unified account in One-way Mode with delta-neutral mode disabled.");
  }
}

export function bitgetSymbolSettings(data: any, symbol: string) {
  assertBitgetAccountSettings(data);
  const config = bitgetList(data.symbolConfigList, "symbol settings")
    .find(r => r.symbol === symbol && r.category === BITGET_CATEGORY && r.marginMode === "isolated");
  if (!config || config.marginMode !== "isolated") {
    throw new TradeRiskError("UNSUPPORTED_MARGIN_MODE", "Bitget UTA isolated margin could not be confirmed for this symbol. Test the connection to retry automatic setup.");
  }
  return config;
}

/** The isolated feasibility endpoint excludes trial funds and accounts for reserved margin. */
export async function bitgetAvailableBalance(api: ExchangeRequest, symbol: string) {
  const result = await api("POST", "/api/v3/account/max-open-available", {
    category: BITGET_CATEGORY, symbol, orderType: "market", side: "buy", marginMode: "isolated",
  });
  return decimal(result.data?.available, "Bitget UTA available isolated margin", true).toFixed();
}

export const bitgetProtectionParams = (tp: string, sl: string) => ({
  takeProfit: tp, stopLoss: sl, tpTriggerBy: "mark", slTriggerBy: "mark", tpOrderType: "market", slOrderType: "market",
});

export function bitgetProtectionSide(row: any, direction: "buy" | "sell") {
  // One-way protection closes on the opposite order side. A missing side is not confirmation.
  return row.side === (direction === "buy" ? "sell" : "buy") &&
    (!row.posSide || row.posSide === (direction === "buy" ? "long" : "short"));
}

