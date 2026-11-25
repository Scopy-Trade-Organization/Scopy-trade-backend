import crypto from "node:crypto";
import axios from "axios";
import { http, getBybitTimestamp } from "./exchangeConnectionService.js";
import {
  getExchangeRestUrl,
  isBitgetDemo,
  isOkxDemo,
} from "./exchangeEnvironment.js";
import type { ExchangeId, RawCredentials } from "../types/index.js";
import { TradeRiskError } from "./tradeRiskService.js";

// Bitget documents these codes as ambiguous submissions: reconcile by clientOid.
const bitgetUnconfirmedCodes = new Set(["40010", "40725", "45001"]);
const bitgetCode = (value: unknown): string | undefined =>
  typeof value === "string" && /^\d{5}$/.test(value) ? value : undefined;

export interface ExchangeFailureDetails {
  endpoint: string;
  method: "GET" | "POST";
  exchangeCode: string;
  parameter?: string;
}
export class ExchangeRequestError extends TradeRiskError {
  constructor(message: string, public details: ExchangeFailureDetails) {
    super("EXCHANGE_REJECTED", message);
  }
}
const bitgetParameterNames = new Set([
  "category", "symbol", "orderId", "clientOid", "qty", "price", "side", "posSide", "orderType",
  "marginMode", "reduceOnly", "type", "tpslMode", "takeProfit", "stopLoss", "tpTriggerBy", "slTriggerBy",
  "tpOrderType", "slOrderType", "tpLimitPrice", "slLimitPrice", "triggerBy", "triggerPrice",
  "triggerOrderType", "triggerOrderPrice", "autoCancel", "newClientOid", "timeInForce",
]);
function bitgetRejection(code: string, msg: unknown, method: "GET" | "POST", endpoint: string) {
  // Extract only a recognized parameter from the documented template. Never copy raw exchange text.
  const match = code === "40019" && typeof msg === "string" && msg.length < 256
    ? /^Parameter\s+["'`]?([A-Za-z][A-Za-z0-9]*)["'`]?\s+can(?:not| not) be empty[.!]?$/i.exec(msg.trim()) : null;
  const parameter = match && bitgetParameterNames.has(match[1]) ? match[1] : undefined;
  return new ExchangeRequestError(`BITGET rejected the request (code ${code}). ${parameter
    ? `Parameter ${parameter} cannot be empty.`
    : code === "40019" ? "A required parameter is empty." : "Check account mode, permissions, order prices and available margin."}`,
  { endpoint, method, exchangeCode: code, ...(parameter ? { parameter } : {}) });
}

/** Signing is shared transport only; account, margin and order APIs stay exchange-specific. */
export function exchangeApi(exchange: ExchangeId, credentials: RawCredentials) {
  return async (
    method: "GET" | "POST",
    path: string,
    values: Record<string, any> = {},
    allowedCodes: Array<string | number> = [],
  ) => {
    const base = getExchangeRestUrl(exchange);
    const query = new URLSearchParams(
      Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    ).toString();
    const target = path + (method === "GET" && query ? `?${query}` : "");
    const body = method === "POST" ? JSON.stringify(values) : "";
    let headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (exchange === "bybit") {
      const timestamp = await getBybitTimestamp(base),
        window = "5000";
      headers = {
        ...headers,
        "X-BAPI-API-KEY": credentials.apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": window,
        "X-BAPI-SIGN": crypto
          .createHmac("sha256", credentials.apiSecret)
          .update(
            timestamp +
              credentials.apiKey +
              window +
              (method === "GET" ? query : body),
          )
          .digest("hex"),
      };
    } else {
      if (!credentials.passphrase)
        throw new TradeRiskError(
          "INVALID_CREDENTIALS",
          `${exchange.toUpperCase()} requires a passphrase.`,
        );
      const timestamp =
        exchange === "okx" ? new Date().toISOString() : String(Date.now());
      const signature = crypto
        .createHmac("sha256", credentials.apiSecret)
        .update(timestamp + method + target + body)
        .digest("base64");
      headers =
        exchange === "okx"
          ? {
              ...headers,
              "OK-ACCESS-KEY": credentials.apiKey,
              "OK-ACCESS-SIGN": signature,
              "OK-ACCESS-TIMESTAMP": timestamp,
              "OK-ACCESS-PASSPHRASE": credentials.passphrase,
              ...(isOkxDemo() ? { "x-simulated-trading": "1" } : {}),
            }
          : {
              ...headers,
              "ACCESS-KEY": credentials.apiKey,
              "ACCESS-SIGN": signature,
              "ACCESS-TIMESTAMP": timestamp,
              "ACCESS-PASSPHRASE": credentials.passphrase,
              ...(isBitgetDemo() ? { paptrading: "1" } : {}),
            };
    }
    let data: any;
    try {
      ({ data } = await http.request({
        method,
        url: base + target,
        headers,
        ...(method === "POST" ? { data: body } : {}),
        "axios-retry": { retries: method === "GET" ? 2 : 0 },
      }));
    } catch (error) {
      const code = axios.isAxiosError(error) ? bitgetCode(error.response?.data?.code) : undefined;
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (exchange === "bitget" && code && status && [400, 401, 403, 429].includes(status) && !bitgetUnconfirmedCodes.has(code)) {
        throw bitgetRejection(code, axios.isAxiosError(error) ? error.response?.data?.msg : undefined, method, path);
      }
      throw new TradeRiskError(
        "EXCHANGE_UNAVAILABLE",
        `${exchange.toUpperCase()} could not confirm the request. Check the exchange before retrying an order.`,
      );
    }
    const code = exchange === "bybit" ? data?.retCode : data?.code;
    const success =
      exchange === "bybit" ? 0 : exchange === "okx" ? "0" : "00000";
    if (exchange === "bitget" && bitgetUnconfirmedCodes.has(code)) {
      throw new TradeRiskError("EXCHANGE_UNAVAILABLE",
        `BITGET could not confirm the request (code ${code}). Reconcile the saved client order ID before retrying.`);
    }
    if (exchange === "bitget" && bitgetCode(code) && code !== success && !allowedCodes.includes(code)) {
      throw bitgetRejection(code, data?.msg, method, path);
    }
    if (code !== success && !allowedCodes.includes(code))
      throw new TradeRiskError(
        "EXCHANGE_REJECTED",
        `${exchange.toUpperCase()} rejected the ${method === "GET" ? "account lookup" : "configuration or order request"} (code ${String(
          code,
        )
          .replace(/[^\w-]/g, "")
          .slice(
            0,
            20,
          )}). Check account mode, permissions and available margin.`,
      );
    if (
      exchange === "okx" &&
      Array.isArray(data?.data) &&
      data.data.some((item: any) => item.sCode && item.sCode !== "0")
    )
      throw new TradeRiskError(
        "EXCHANGE_REJECTED",
        "OKX rejected the order or protection request. Check account mode and order limits.",
      );
    return data;
  };
}
export type ExchangeRequest = ReturnType<typeof exchangeApi>;
