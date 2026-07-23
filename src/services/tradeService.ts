import crypto from "crypto";
import axios from "axios";
import { RawCredentials, ExchangeId } from "../types/index.js";
import {
  http,
  normalizeError,
  getBybitTimestamp,
} from "./exchangeConnectionService.js";
import { getExchangeRestUrl } from "./exchangeEnvironment.js";

const BITGET_BASE_URL = process.env.BITGET_BASE_URL || "https://api.bitget.com";

// ─── Order Types ──────────────────────────────────────────────────────────────

export interface PlaceOrderParams {
  credentials: RawCredentials;
  pair: string; // e.g. "BTCUSDT"
  direction: "buy" | "sell";
  quantity: string; // base asset quantity
  entryPrice: string; // limit price
  tp: string;
  sl: string;
}

export interface PlacedOrderResult {
  orderId: string;
  raw: unknown;
  execution?: {
    quantity: string;
    entryPrice: string;
    tp: string;
    sl: string;
  };
}

export interface OrderStatusResult {
  status: "pending" | "filled" | "closed" | "cancelled" | "failed";
  filledPrice: string | null;
  raw: unknown;
}

export interface CurrentPriceResult {
  price: string;
  raw: unknown;
}

// ─── Balance Types ────────────────────────────────────────────────────────────

export interface AssetBalance {
  asset: string;
  free: string;
  locked: string;
}

export interface ExchangeBalance {
  balances: AssetBalance[]; // non-zero assets only
  totalUsdtEquivalent: string | null; // provided natively by some exchanges
}

// ─── Pair Normalization ──────────────────────────────────────────────────────

function normalizePairForExchange(exchange: ExchangeId, pair: string): string {
  // Remove any slashes first
  let normalized = pair.replace(/\//g, "");

  // OKX uses dash separator for futures too
  if (exchange === "okx") {
    const match = normalized.match(/^([A-Z]+)(USDT|USD|BUSD|USDC)$/);
    if (match) {
      return `${match[1]}-${match[2]}`;
    }
    return normalized;
  }

  // Binance, Bybit, Bitget all use no separator for futures
  return normalized;
}

function decimalPlaces(step: string): number {
  const normalized = step.replace(/0+$/, "");
  const dot = normalized.indexOf(".");
  return dot === -1 ? 0 : normalized.length - dot - 1;
}

function alignToStep(value: string, step: string, roundDown = false): string {
  const numericValue = Number(value);
  const numericStep = Number(step);
  if (!Number.isFinite(numericValue) || !Number.isFinite(numericStep) || numericStep <= 0) {
    throw new Error(`Invalid exchange precision value: ${value} / ${step}`);
  }
  const units = numericValue / numericStep;
  const alignedUnits = roundDown ? Math.floor(units + 1e-10) : Math.round(units);
  return (alignedUnits * numericStep).toFixed(decimalPlaces(step));
}

async function prepareFuturesOrder(
  exchange: ExchangeId,
  p: PlaceOrderParams,
): Promise<PlaceOrderParams> {
  if (exchange !== "binance" && exchange !== "bybit") return p;

  const baseUrl = getExchangeRestUrl(exchange);
  const symbol = normalizePairForExchange(exchange, p.pair);

  if (exchange === "binance") {
    const { data } = await http.get(`${baseUrl}/fapi/v1/exchangeInfo`);
    const instrument = data.symbols?.find((item: any) => item.symbol === symbol);
    if (!instrument) throw new Error(`Binance Futures does not support ${symbol}.`);
    const priceFilter = instrument.filters?.find((item: any) => item.filterType === "PRICE_FILTER");
    const lotFilter = instrument.filters?.find((item: any) => item.filterType === "LOT_SIZE");
    const minNotionalFilter = instrument.filters?.find((item: any) => item.filterType === "MIN_NOTIONAL");
    if (!priceFilter?.tickSize || !lotFilter?.stepSize) {
      throw new Error(`Binance returned incomplete Futures rules for ${symbol}.`);
    }
    const quantity = alignToStep(p.quantity, lotFilter.stepSize, true);
    const entryPrice = alignToStep(p.entryPrice, priceFilter.tickSize);
    const tp = alignToStep(p.tp, priceFilter.tickSize);
    const sl = alignToStep(p.sl, priceFilter.tickSize);
    if (
      Number(quantity) < Number(lotFilter.minQty || 0) ||
      Number(quantity) * Number(entryPrice) < Number(minNotionalFilter?.notional || 0)
    ) {
      throw new Error(`Calculated quantity is below Binance Futures minimum for ${symbol}.`);
    }
    return { ...p, quantity, entryPrice, tp, sl };
  }

  const { data } = await http.get(`${baseUrl}/v5/market/instruments-info`, {
    params: { category: "linear", symbol },
  });
  if (data.retCode !== 0) throw new Error(data.retMsg || "Bybit instrument lookup failed.");
  const instrument = data.result?.list?.[0];
  if (!instrument) throw new Error(`Bybit Linear does not support ${symbol}.`);
  const qtyStep = instrument.lotSizeFilter?.qtyStep;
  const tickSize = instrument.priceFilter?.tickSize;
  if (!qtyStep || !tickSize) throw new Error(`Bybit returned incomplete Linear rules for ${symbol}.`);
  const quantity = alignToStep(p.quantity, qtyStep, true);
  const entryPrice = alignToStep(p.entryPrice, tickSize);
  const tp = alignToStep(p.tp, tickSize);
  const sl = alignToStep(p.sl, tickSize);
  if (
    Number(quantity) < Number(instrument.lotSizeFilter?.minOrderQty || 0) ||
    Number(quantity) * Number(entryPrice) < Number(instrument.lotSizeFilter?.minNotionalValue || 0)
  ) {
    throw new Error(`Calculated quantity is below Bybit Linear minimum for ${symbol}.`);
  }
  return { ...p, quantity, entryPrice, tp, sl };
}

// ─── Order Placement ──────────────────────────────────────────────────────────

// ── Binance Futures — places limit order with TP/SL
async function placeBinanceOrder(
  p: PlaceOrderParams,
): Promise<PlacedOrderResult> {
  const { apiKey, apiSecret } = p.credentials;
  const baseUrl = getExchangeRestUrl("binance");
  const normalizedPair = normalizePairForExchange("binance", p.pair);

  const getTimestamp = async () => {
    const { data } = await http.get(`${baseUrl}/fapi/v1/time`);
    return data.serverTime as number;
  };

  const sign = (qs: string) =>
    crypto.createHmac("sha256", apiSecret).update(qs).digest("hex");

  // 1. Place the limit entry order
  const ts = await getTimestamp();
  const side = p.direction.toUpperCase();

  const entryQs = `symbol=${normalizedPair}&side=${side}&type=LIMIT&timeInForce=GTC&quantity=${p.quantity}&price=${p.entryPrice}&timestamp=${ts}`;
  const { data: orderData } = await http.post(
    `${baseUrl}/fapi/v1/order`,
    null,
    {
      params: {
        ...Object.fromEntries(new URLSearchParams(entryQs)),
        signature: sign(entryQs),
      },
      headers: { "X-MBX-APIKEY": apiKey },
    },
  );

  const orderId = String(orderData.orderId);

  return {
    orderId,
    raw: orderData,
    execution: {
      quantity: p.quantity,
      entryPrice: p.entryPrice,
      tp: p.tp,
      sl: p.sl,
    },
  };
}

// ── Bybit Futures (Linear) — places limit order with TP/SL in a single call
async function placeBybitOrder(
  p: PlaceOrderParams,
): Promise<PlacedOrderResult> {
  const { apiKey, apiSecret } = p.credentials;
  const baseUrl = getExchangeRestUrl("bybit");
  const normalizedPair = normalizePairForExchange("bybit", p.pair);

  const timestamp = await getBybitTimestamp(baseUrl);
  const recvWindow = "5000";

  const body = JSON.stringify({
    category: "linear",
    symbol: normalizedPair,
    side: p.direction === "buy" ? "Buy" : "Sell",
    orderType: "Limit",
    qty: p.quantity,
    price: p.entryPrice,
    takeProfit: p.tp,
    stopLoss: p.sl,
    tpslMode: "Full",
    tpOrderType: "Market",
    slOrderType: "Market",
    tpTriggerBy: "MarkPrice",
    slTriggerBy: "MarkPrice",
    timeInForce: "GTC",
    positionIdx: 0,
  });

  const signPayload = timestamp + apiKey + recvWindow + body;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("hex");

  interface BybitOrderResponse {
    retCode: number;
    retMsg: string;
    result: { orderId: string };
  }

  const { data } = await http.post<BybitOrderResponse>(
    `${baseUrl}/v5/order/create`,
    body,
    {
      headers: {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-SIGN": signature,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
        "Content-Type": "application/json",
      },
    },
  );

  if (data.retCode !== 0) throw new Error(data.retMsg || "Bybit order failed.");
  return {
    orderId: data.result.orderId,
    raw: data,
    execution: {
      quantity: p.quantity,
      entryPrice: p.entryPrice,
      tp: p.tp,
      sl: p.sl,
    },
  };
}

// ── OKX Futures — places limit order with attached TP/SL
async function placeOkxOrder(p: PlaceOrderParams): Promise<PlacedOrderResult> {
  const { apiKey, apiSecret, passphrase } = p.credentials;
  if (!passphrase) throw new Error("OKX requires a passphrase.");

  const normalizedPair = normalizePairForExchange("okx", p.pair);

  const timestamp = new Date().toISOString();
  const method = "POST";
  const path = "/api/v5/trade/order";
  const body = JSON.stringify({
    instId: normalizedPair,
    tdMode: "cross",
    side: p.direction,
    ordType: "limit",
    sz: p.quantity,
    px: p.entryPrice,
    tpTriggerPx: p.tp,
    tpOrdPx: p.tp,
    slTriggerPx: p.sl,
    slOrdPx: p.sl,
    posSide: "net",
  });

  const signPayload = timestamp + method + path + body;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("base64");

  interface OkxOrderResponse {
    code: string;
    msg: string;
    data: Array<{ ordId: string; sCode: string; sMsg: string }>;
  }

  const { data } = await http.post<OkxOrderResponse>(
    "https://www.okx.com" + path,
    body,
    {
      headers: {
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": passphrase,
        "Content-Type": "application/json",
        "x-simulated-trading": "1",
      },
    },
  );

  if (data.code !== "0") throw new Error(data.msg || "OKX order failed.");
  const result = data.data[0];
  if (result?.sCode !== "0")
    throw new Error(result?.sMsg || "OKX order error.");
  return { orderId: result.ordId, raw: data };
}

// ── Bitget Futures (Mix) — places limit order
async function placeBitgetOrder(
  p: PlaceOrderParams,
): Promise<PlacedOrderResult> {
  const { apiKey, apiSecret, passphrase } = p.credentials;
  if (!passphrase) throw new Error("Bitget requires a passphrase.");

  const normalizedPair = normalizePairForExchange("bitget", p.pair);

  const timestamp = Date.now().toString();
  const method = "POST";
  const path = "/api/v2/mix/order/place-order";
  const body = JSON.stringify({
    symbol: normalizedPair,
    productType: "USDT-FUTURES",
    marginMode: "crossed",
    marginCoin: "USDT",
    size: p.quantity,
    price: p.entryPrice,
    side: p.direction,
    tradeSide: "open",
    orderType: "limit",
    force: "gtc",
  });

  const signPayload = timestamp + method + path + body;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("base64");

  interface BitgetOrderResponse {
    code: string;
    msg: string;
    data: { orderId: string };
  }

  const { data } = await http.post<BitgetOrderResponse>(
    BITGET_BASE_URL + path,
    body,
    {
      headers: {
        ...(process.env.BITGET_DEMO_MODE === "true" ? { paptrading: "1" } : {}),
        "ACCESS-KEY": apiKey,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": passphrase,
        "Content-Type": "application/json",
      },
    },
  );

  if (data.code !== "00000")
    throw new Error(data.msg || "Bitget order failed.");

  const orderId = data.data.orderId;

  // Bitget requires separate TP/SL orders after placing the main order
  try {
    // Set Take Profit
    const tpBody = JSON.stringify({
      symbol: normalizedPair,
      productType: "USDT-FUTURES",
      marginCoin: "USDT",
      size: p.quantity,
      triggerPrice: p.tp,
      executePrice: p.tp,
      side: p.direction === "buy" ? "sell" : "buy",
      orderType: "limit",
      triggerType: "fill_price",
      tradeSide: "close",
    });

    const tpSignPayload =
      timestamp + method + "/api/v2/mix/order/place-tp-sl-order" + tpBody;
    const tpSignature = crypto
      .createHmac("sha256", apiSecret)
      .update(tpSignPayload)
      .digest("base64");

    await http.post(
      BITGET_BASE_URL + "/api/v2/mix/order/place-tp-sl-order",
      tpBody,
      {
        headers: {
          ...(process.env.BITGET_DEMO_MODE === "true"
            ? { paptrading: "1" }
            : {}),
          "ACCESS-KEY": apiKey,
          "ACCESS-SIGN": tpSignature,
          "ACCESS-TIMESTAMP": timestamp,
          "ACCESS-PASSPHRASE": passphrase,
          "Content-Type": "application/json",
        },
      },
    );

    // Set Stop Loss
    const slBody = JSON.stringify({
      symbol: normalizedPair,
      productType: "USDT-FUTURES",
      marginCoin: "USDT",
      size: p.quantity,
      triggerPrice: p.sl,
      executePrice: p.sl,
      side: p.direction === "buy" ? "sell" : "buy",
      orderType: "limit",
      triggerType: "fill_price",
      tradeSide: "close",
    });

    const slSignPayload =
      timestamp + method + "/api/v2/mix/order/place-tp-sl-order" + slBody;
    const slSignature = crypto
      .createHmac("sha256", apiSecret)
      .update(slSignPayload)
      .digest("base64");

    await http.post(
      BITGET_BASE_URL + "/api/v2/mix/order/place-tp-sl-order",
      slBody,
      {
        headers: {
          ...(process.env.BITGET_DEMO_MODE === "true"
            ? { paptrading: "1" }
            : {}),
          "ACCESS-KEY": apiKey,
          "ACCESS-SIGN": slSignature,
          "ACCESS-TIMESTAMP": timestamp,
          "ACCESS-PASSPHRASE": passphrase,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (tpSlErr) {
    console.warn("Failed to set TP/SL for Bitget:", tpSlErr);
  }

  return { orderId, raw: data };
}

// ─── Order Status Checkers ─────────────────────────────────────────────────────

async function getBinanceOrderStatus(
  credentials: RawCredentials,
  pair: string,
  orderId: string,
): Promise<OrderStatusResult> {
  const { apiKey, apiSecret } = credentials;
  const baseUrl = getExchangeRestUrl("binance");
  const normalizedPair = normalizePairForExchange("binance", pair);

  const { data: timeData } = await http.get(`${baseUrl}/fapi/v1/time`);
  const ts = timeData.serverTime as number;
  const qs = `symbol=${normalizedPair}&orderId=${orderId}&timestamp=${ts}`;
  const sig = crypto.createHmac("sha256", apiSecret).update(qs).digest("hex");

  const { data } = await http.get(`${baseUrl}/fapi/v1/order`, {
    params: { ...Object.fromEntries(new URLSearchParams(qs)), signature: sig },
    headers: { "X-MBX-APIKEY": apiKey },
  });

  const statusMap: Record<string, OrderStatusResult["status"]> = {
    FILLED: "filled",
    CANCELED: "cancelled",
    REJECTED: "failed",
    EXPIRED: "cancelled",
    NEW: "pending",
    PARTIALLY_FILLED: "pending",
  };

  const executedQty = parseFloat(data.executedQty ?? "0");
  const cummulativeQuoteQty = parseFloat(data.cummulativeQuoteQty ?? "0");
  const averageFillPrice =
    executedQty > 0 && cummulativeQuoteQty > 0
      ? String(cummulativeQuoteQty / executedQty)
      : data.avgPrice || data.price || null;

  return {
    status: statusMap[data.status] ?? "pending",
    filledPrice: averageFillPrice,
    raw: data,
  };
}

async function getBybitOrderStatus(
  credentials: RawCredentials,
  pair: string,
  orderId: string,
): Promise<OrderStatusResult> {
  const { apiKey, apiSecret } = credentials;
  const baseUrl = getExchangeRestUrl("bybit");
  const normalizedPair = normalizePairForExchange("bybit", pair);

  const timestamp = await getBybitTimestamp(baseUrl);
  const recvWindow = "5000";
  const signPayload = `${timestamp}${apiKey}${recvWindow}category=linear&orderId=${orderId}&symbol=${normalizedPair}`;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("hex");

  interface BybitStatusResponse {
    retCode: number;
    retMsg: string;
    result: { list: Array<{ orderStatus: string; avgPrice: string }> };
  }

  const { data } = await http.get<BybitStatusResponse>(
    `${baseUrl}/v5/order/history`,
    {
      params: { category: "linear", orderId, symbol: normalizedPair },
      headers: {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-SIGN": signature,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
      },
    },
  );

  if (data.retCode !== 0) throw new Error(data.retMsg);
  const order = data.result.list[0];
  if (!order) throw new Error("Order not found on Bybit.");

  const statusMap: Record<string, OrderStatusResult["status"]> = {
    Filled: "filled",
    Cancelled: "cancelled",
    Rejected: "failed",
    New: "pending",
    PartiallyFilled: "pending",
  };

  return {
    status: statusMap[order.orderStatus] ?? "pending",
    filledPrice: order.avgPrice || null,
    raw: data,
  };
}

async function getOkxOrderStatus(
  credentials: RawCredentials,
  pair: string,
  orderId: string,
): Promise<OrderStatusResult> {
  const { apiKey, apiSecret, passphrase } = credentials;
  if (!passphrase) throw new Error("OKX requires a passphrase.");

  const normalizedPair = normalizePairForExchange("okx", pair);

  const timestamp = new Date().toISOString();
  const method = "GET";
  const path = `/api/v5/trade/order?instId=${normalizedPair}&ordId=${orderId}`;
  const signPayload = timestamp + method + path;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("base64");

  interface OkxStatusResponse {
    code: string;
    data: Array<{ state: string; avgPx: string }>;
  }

  const { data } = await http.get<OkxStatusResponse>(
    "https://www.okx.com" + path,
    {
      headers: {
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": passphrase,
        "x-simulated-trading": "1",
      },
    },
  );

  const order = data.data[0];
  if (!order) throw new Error("Order not found on OKX.");

  const statusMap: Record<string, OrderStatusResult["status"]> = {
    filled: "filled",
    canceled: "cancelled",
    live: "pending",
    partially_filled: "pending",
  };

  return {
    status: statusMap[order.state] ?? "pending",
    filledPrice: order.avgPx || null,
    raw: data,
  };
}

async function getBitgetOrderStatus(
  credentials: RawCredentials,
  pair: string,
  orderId: string,
): Promise<OrderStatusResult> {
  const { apiKey, apiSecret, passphrase } = credentials;
  if (!passphrase) throw new Error("Bitget requires a passphrase.");

  const normalizedPair = normalizePairForExchange("bitget", pair);

  const timestamp = Date.now().toString();
  const method = "GET";
  const path = `/api/v2/mix/order/detail?symbol=${normalizedPair}&productType=USDT-FUTURES&orderId=${orderId}`;
  const signPayload = timestamp + method + path;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("base64");

  interface BitgetStatusResponse {
    code: string;
    data: { status: string; priceAvg: string };
  }

  const { data } = await http.get<BitgetStatusResponse>(
    BITGET_BASE_URL + path,
    {
      headers: {
        ...(process.env.BITGET_DEMO_MODE === "true" ? { paptrading: "1" } : {}),
        "ACCESS-KEY": apiKey,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": passphrase,
        "Content-Type": "application/json",
      },
    },
  );

  const order = data.data;
  if (!order) throw new Error("Order not found on Bitget.");

  const statusMap: Record<string, OrderStatusResult["status"]> = {
    full_fill: "filled",
    partial_fill: "pending",
    cancelled: "cancelled",
    live: "pending",
  };

  return {
    status: statusMap[order.status] ?? "pending",
    filledPrice: order.priceAvg || null,
    raw: data,
  };
}

// ─── Market Price Fetchers ───────────────────────────────────────────────────

async function getBinanceCurrentPrice(
  pair: string,
): Promise<CurrentPriceResult> {
  const baseUrl = getExchangeRestUrl("binance");
  const normalizedPair = normalizePairForExchange("binance", pair);

  const { data } = await http.get(`${baseUrl}/fapi/v1/ticker/price`, {
    params: { symbol: normalizedPair },
  });

  if (!data?.price) throw new Error("Binance returned an invalid ticker.");
  return { price: String(data.price), raw: data };
}

async function getBybitCurrentPrice(pair: string): Promise<CurrentPriceResult> {
  const baseUrl = getExchangeRestUrl("bybit");
  const normalizedPair = normalizePairForExchange("bybit", pair);

  const { data } = await http.get(`${baseUrl}/v5/market/tickers`, {
    params: { category: "linear", symbol: normalizedPair },
  });

  if (data.retCode !== 0)
    throw new Error(data.retMsg || "Bybit ticker failed.");
  const ticker = data.result?.list?.[0];
  if (!ticker?.lastPrice) throw new Error("Bybit returned an invalid ticker.");

  return { price: String(ticker.lastPrice), raw: data };
}

async function getOkxCurrentPrice(pair: string): Promise<CurrentPriceResult> {
  const normalizedPair = normalizePairForExchange("okx", pair);

  const { data } = await http.get("https://www.okx.com/api/v5/market/ticker", {
    params: { instId: normalizedPair },
  });

  if (data.code !== "0") throw new Error(data.msg || "OKX ticker failed.");
  const ticker = data.data?.[0];
  if (!ticker?.last) throw new Error("OKX returned an invalid ticker.");

  return { price: String(ticker.last), raw: data };
}

async function getBitgetCurrentPrice(
  pair: string,
): Promise<CurrentPriceResult> {
  const normalizedPair = normalizePairForExchange("bitget", pair);

  const { data } = await http.get(
    BITGET_BASE_URL + "/api/v2/mix/market/ticker",
    {
      params: { symbol: normalizedPair, productType: "USDT-FUTURES" },
      headers: {
        ...(process.env.BITGET_DEMO_MODE === "true" ? { paptrading: "1" } : {}),
      },
    },
  );

  if (data.code !== "00000")
    throw new Error(data.msg || "Bitget ticker failed.");
  const ticker = data.data?.[0];
  if (!ticker?.lastPr) throw new Error("Bitget returned an invalid ticker.");

  return { price: String(ticker.lastPr), raw: data };
}

// ─── Balance Fetchers ─────────────────────────────────────────────────────────

async function getBinanceBalance(
  credentials: RawCredentials,
): Promise<ExchangeBalance> {
  const { apiKey, apiSecret } = credentials;
  const baseUrl = getExchangeRestUrl("binance");

  try {
    const { data: timeData } = await http.get(`${baseUrl}/fapi/v1/time`);
    const timestamp = timeData.serverTime as number;

    const qs = `timestamp=${timestamp}`;
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(qs)
      .digest("hex");

    interface BinanceAccountResponse {
      assets: Array<{
        asset: string;
        walletBalance: string;
        marginBalance: string;
      }>;
    }

    const { data } = await http.get<BinanceAccountResponse>(
      `${baseUrl}/fapi/v2/account`,
      {
        params: { timestamp, signature },
        headers: { "X-MBX-APIKEY": apiKey },
      },
    );

    const nonZero = data.assets.filter((b) => parseFloat(b.walletBalance) > 0);

    const usdtEntry = nonZero.find((b) => b.asset === "USDT");

    return {
      balances: nonZero.map((b) => ({
        asset: b.asset,
        free: b.walletBalance,
        locked: "0",
      })),
      totalUsdtEquivalent: usdtEntry?.walletBalance || null,
    };
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.msg || err?.message;

    if (status === 401 || status === 403) {
      throw new Error("Binance: Insufficient permissions");
    }

    throw new Error(`Binance error: ${msg || "Unknown error"}`);
  }
}

async function getBybitBalance(
  credentials: RawCredentials,
): Promise<ExchangeBalance> {
  const { apiKey, apiSecret } = credentials;
  const baseUrl = getExchangeRestUrl("bybit");

  try {
    const timestamp = await getBybitTimestamp(baseUrl);
    const recvWindow = "5000";
    const queryString = "accountType=UNIFIED";
    const signPayload = timestamp + apiKey + recvWindow + queryString;
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(signPayload)
      .digest("hex");

    interface BybitBalanceResponse {
      retCode: number;
      retMsg: string;
      result: {
        list: Array<{
          totalEquity: string;
          coin: Array<{
            coin: string;
            walletBalance: string;
            locked: string;
          }>;
        }>;
      };
    }

    const { data } = await http.get<BybitBalanceResponse>(
      `${baseUrl}/v5/account/wallet-balance`,
      {
        params: { accountType: "UNIFIED" },
        headers: {
          "X-BAPI-API-KEY": apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
        },
      },
    );

    if (data.retCode !== 0)
      throw new Error(data.retMsg || "Bybit balance fetch failed.");

    const account = data.result.list[0];
    if (!account) throw new Error("Bybit returned an empty wallet response.");

    const nonZero = account.coin.filter((c) => parseFloat(c.walletBalance) > 0);

    return {
      balances: nonZero.map((c) => ({
        asset: c.coin,
        free: String(parseFloat(c.walletBalance) - parseFloat(c.locked || "0")),
        locked: c.locked || "0",
      })),
      totalUsdtEquivalent: account.totalEquity || null,
    };
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.retMsg || err?.message;

    if (status === 401 || status === 403) {
      throw new Error("Bybit: Insufficient permissions");
    }

    throw new Error(`Bybit error: ${msg || "Unknown error"}`);
  }
}

async function getOkxBalance(
  credentials: RawCredentials,
): Promise<ExchangeBalance> {
  const { apiKey, apiSecret, passphrase } = credentials;
  if (!passphrase) throw new Error("OKX requires a passphrase.");

  const timestamp = new Date().toISOString();
  const method = "GET";
  const path = "/api/v5/account/balance";
  const signPayload = timestamp + method + path;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("base64");

  interface OkxBalanceResponse {
    code: string;
    msg: string;
    data: Array<{
      totalEq: string;
      details: Array<{
        ccy: string;
        availBal: string;
        frozenBal: string;
      }>;
    }>;
  }

  const { data } = await http.get<OkxBalanceResponse>(
    "https://www.okx.com" + path,
    {
      headers: {
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": passphrase,
        "x-simulated-trading": "1",
      },
    },
  );

  if (data.code !== "0")
    throw new Error(data.msg || "OKX balance fetch failed.");

  const account = data.data[0];
  if (!account) throw new Error("OKX returned an empty balance response.");

  const nonZero = account.details.filter(
    (d) => parseFloat(d.availBal) > 0 || parseFloat(d.frozenBal) > 0,
  );

  return {
    balances: nonZero.map((d) => ({
      asset: d.ccy,
      free: d.availBal,
      locked: d.frozenBal,
    })),
    totalUsdtEquivalent: account.totalEq || null,
  };
}

async function getBitgetBalance(
  credentials: RawCredentials,
): Promise<ExchangeBalance> {
  const { apiKey, apiSecret, passphrase } = credentials;
  if (!passphrase) throw new Error("Bitget requires a passphrase.");

  const timestamp = Date.now().toString();
  const method = "GET";
  const queryString = "productType=USDT-FUTURES&marginCoin=USDT";
  const path = "/api/v2/mix/account/accounts";
  const signPayload = timestamp + method + path + "?" + queryString;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("base64");

  interface BitgetBalanceResponse {
    code: string;
    msg: string;
    data: Array<{
      marginCoin: string;
      available: string;
      locked: string;
      usdtEquity: string;
    }>;
  }

  const { data } = await http.get<BitgetBalanceResponse>(
    BITGET_BASE_URL + path,
    {
      params: { productType: "USDT-FUTURES", marginCoin: "USDT" },
      headers: {
        ...(process.env.BITGET_DEMO_MODE === "true" ? { paptrading: "1" } : {}),
        "ACCESS-KEY": apiKey,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": passphrase,
        "Content-Type": "application/json",
      },
    },
  );

  if (data.code !== "00000")
    throw new Error(data.msg || "Bitget balance fetch failed.");

  const nonZero = (data.data ?? []).filter(
    (a) => parseFloat(a.available) > 0 || parseFloat(a.locked) > 0,
  );

  const totalUsdt = nonZero.reduce(
    (sum, a) => sum + parseFloat(a.usdtEquity || "0"),
    0,
  );

  return {
    balances: nonZero.map((a) => ({
      asset: a.marginCoin,
      free: a.available,
      locked: a.locked || "0",
    })),
    totalUsdtEquivalent: totalUsdt > 0 ? String(totalUsdt) : null,
  };
}

// ─── Order Registry ───────────────────────────────────────────────────────────

const orderPlacer: Record<
  ExchangeId,
  (p: PlaceOrderParams) => Promise<PlacedOrderResult>
> = {
  binance: placeBinanceOrder,
  bybit: placeBybitOrder,
  okx: placeOkxOrder,
  bitget: placeBitgetOrder,
};

const statusChecker: Record<
  ExchangeId,
  (
    creds: RawCredentials,
    pair: string,
    orderId: string,
  ) => Promise<OrderStatusResult>
> = {
  binance: getBinanceOrderStatus,
  bybit: getBybitOrderStatus,
  okx: getOkxOrderStatus,
  bitget: getBitgetOrderStatus,
};

const priceFetcher: Record<
  ExchangeId,
  (pair: string) => Promise<CurrentPriceResult>
> = {
  binance: getBinanceCurrentPrice,
  bybit: getBybitCurrentPrice,
  okx: getOkxCurrentPrice,
  bitget: getBitgetCurrentPrice,
};

const balanceFetcher: Record<
  ExchangeId,
  (credentials: RawCredentials) => Promise<ExchangeBalance>
> = {
  binance: getBinanceBalance,
  bybit: getBybitBalance,
  okx: getOkxBalance,
  bitget: getBitgetBalance,
};

// ─── Public Trading API ──────────────────────────────────────────────────────

export async function placeOrder(
  exchange: ExchangeId,
  params: PlaceOrderParams,
): Promise<PlacedOrderResult> {
  try {
    const prepared = await prepareFuturesOrder(exchange, params);
    const placed = await orderPlacer[exchange](prepared);
    return {
      ...placed,
      execution: {
        quantity: prepared.quantity,
        entryPrice: prepared.entryPrice,
        tp: prepared.tp,
        sl: prepared.sl,
      },
    };
  } catch (err) {
    throw normalizeError(err);
  }
}

export async function getOrderStatus(
  exchange: ExchangeId,
  credentials: RawCredentials,
  pair: string,
  orderId: string,
): Promise<OrderStatusResult> {
  try {
    return await statusChecker[exchange](credentials, pair, orderId);
  } catch (err) {
    throw normalizeError(err);
  }
}

export async function getCurrentPrice(
  exchange: ExchangeId,
  pair: string,
): Promise<CurrentPriceResult> {
  try {
    return await priceFetcher[exchange](pair);
  } catch (err) {
    throw normalizeError(err);
  }
}

export async function attachBinanceTpSl(
  params: PlaceOrderParams & { orderId: string },
): Promise<{ tpOrderId: string; slOrderId: string }> {
  try {
    const { apiKey, apiSecret } = params.credentials;
    const baseUrl = getExchangeRestUrl("binance");
    const symbol = normalizePairForExchange("binance", params.pair);
    const side = params.direction === "buy" ? "SELL" : "BUY";
    const sign = (query: string) =>
      crypto.createHmac("sha256", apiSecret).update(query).digest("hex");
    const { data: timeData } = await http.get(`${baseUrl}/fapi/v1/time`);

    const placeTrigger = async (
      type: "TAKE_PROFIT_MARKET" | "STOP_MARKET",
      stopPrice: string,
      timestamp: number,
    ) => {
      const query = `symbol=${symbol}&side=${side}&type=${type}&stopPrice=${stopPrice}&closePosition=true&workingType=MARK_PRICE&timestamp=${timestamp}`;
      const { data } = await http.post(`${baseUrl}/fapi/v1/order`, null, {
        params: {
          ...Object.fromEntries(new URLSearchParams(query)),
          signature: sign(query),
        },
        headers: { "X-MBX-APIKEY": apiKey },
      });
      return String(data.orderId);
    };

    const tpOrderId = await placeTrigger(
      "TAKE_PROFIT_MARKET",
      params.tp,
      Number(timeData.serverTime),
    );
    const slOrderId = await placeTrigger(
      "STOP_MARKET",
      params.sl,
      Number(timeData.serverTime) + 1,
    );
    return { tpOrderId, slOrderId };
  } catch (err) {
    throw normalizeError(err);
  }
}

// ─── Public Balance API ───────────────────────────────────────────────────────

export async function getExchangeBalance(
  exchange: ExchangeId,
  credentials: RawCredentials,
): Promise<ExchangeBalance> {
  try {
    return await balanceFetcher[exchange](credentials);
  } catch (err) {
    const error = normalizeError(err);
    (error as any).exchange = exchange;
    throw error;
  }
}
