import crypto from "crypto";
import {
  http,
  normalizeError,
  getBybitTimestamp,
} from "./exchangeConnectionService.js";
import { RawCredentials, ExchangeId } from "../types/index.js";

// ─── Order Types ──────────────────────────────────────────────────────────────

export interface PlaceOrderParams {
  credentials: RawCredentials;
  pair: string; // Exchange-native symbol: "BTCUSDT" (Binance/Bybit/Bitget), "BTC-USDT-SWAP" (OKX)
  direction: "buy" | "sell"; // buy = open long, sell = open short
  quantity: string; // Contract quantity in base asset
  entryPrice: string; // Limit price
  tp: string;
  sl: string;
}

export interface PlacedOrderResult {
  orderId: string;
  raw: unknown;
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

// ─── Order Placement (Futures / Perpetuals) ───────────────────────────────────
//
// Binance  → USD-M Futures /fapi/v1/order       one-way mode, TP/SL as reduce-only orders
// Bybit    → Linear perp   /v5/order/create     category: linear, TP/SL inline
// OKX      → SWAP          /api/v5/trade/order  tdMode: cross, TP/SL inline
// Bitget   → USDT-FUTURES  /api/v2/mix/order/place-order  TP/SL inline

async function placeBinanceOrder(
  p: PlaceOrderParams,
): Promise<PlacedOrderResult> {
  const { apiKey, apiSecret } = p.credentials;
  const baseUrl =
    process.env.BINANCE_FUTURES_URL ?? "https://testnet.binancefuture.com";

  const sign = (qs: string) =>
    crypto.createHmac("sha256", apiSecret).update(qs).digest("hex");

  const getTs = async () => {
    const { data } = await http.get(`${baseUrl}/fapi/v1/time`);
    return data.serverTime as number;
  };

  const side = p.direction.toUpperCase(); // BUY | SELL
  const exitSide = p.direction === "buy" ? "SELL" : "BUY";

  // 1. Entry limit order (positionSide=BOTH = one-way/net mode)
  const entryQs =
    `symbol=${p.pair}` +
    `&side=${side}` +
    `&positionSide=BOTH` +
    `&type=LIMIT` +
    `&timeInForce=GTC` +
    `&quantity=${p.quantity}` +
    `&price=${p.entryPrice}` +
    `&timestamp=${await getTs()}`;

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

  // 2. Take-profit reduce-only order
  const tpQs =
    `symbol=${p.pair}` +
    `&side=${exitSide}` +
    `&positionSide=BOTH` +
    `&type=TAKE_PROFIT` +
    `&timeInForce=GTC` +
    `&quantity=${p.quantity}` +
    `&price=${p.tp}` +
    `&stopPrice=${p.tp}` +
    `&reduceOnly=true` +
    `&timestamp=${await getTs()}`;

  await http.post(`${baseUrl}/fapi/v1/order`, null, {
    params: {
      ...Object.fromEntries(new URLSearchParams(tpQs)),
      signature: sign(tpQs),
    },
    headers: { "X-MBX-APIKEY": apiKey },
  });

  // 3. Stop-loss reduce-only order
  const slQs =
    `symbol=${p.pair}` +
    `&side=${exitSide}` +
    `&positionSide=BOTH` +
    `&type=STOP` +
    `&timeInForce=GTC` +
    `&quantity=${p.quantity}` +
    `&price=${p.sl}` +
    `&stopPrice=${p.sl}` +
    `&reduceOnly=true` +
    `&timestamp=${await getTs()}`;

  await http.post(`${baseUrl}/fapi/v1/order`, null, {
    params: {
      ...Object.fromEntries(new URLSearchParams(slQs)),
      signature: sign(slQs),
    },
    headers: { "X-MBX-APIKEY": apiKey },
  });

  return { orderId: String(orderData.orderId), raw: orderData };
}

async function placeBybitOrder(
  p: PlaceOrderParams,
): Promise<PlacedOrderResult> {
  const { apiKey, apiSecret } = p.credentials;
  const baseUrl = process.env.BYBIT_TEST_API_URL!;

  const timestamp = await getBybitTimestamp(baseUrl);
  const recvWindow = "5000";

  // category: "linear" = USDT-margined perpetual contracts
  const body = JSON.stringify({
    category: "linear",
    symbol: p.pair,
    side: p.direction === "buy" ? "Buy" : "Sell",
    orderType: "Limit",
    qty: p.quantity,
    price: p.entryPrice,
    takeProfit: p.tp,
    stopLoss: p.sl,
    tpTriggerBy: "MarkPrice",
    slTriggerBy: "MarkPrice",
    timeInForce: "GTC",
    reduceOnly: false,
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
  return { orderId: data.result.orderId, raw: data };
}

async function placeOkxOrder(p: PlaceOrderParams): Promise<PlacedOrderResult> {
  const { apiKey, apiSecret, passphrase } = p.credentials;
  if (!passphrase) throw new Error("OKX requires a passphrase.");

  const timestamp = new Date().toISOString();
  const method = "POST";
  const path = "/api/v5/trade/order";

  // instId must be a SWAP instrument e.g. "BTC-USDT-SWAP"
  // tdMode "cross" = cross-margin perpetual futures
  // posSide "net" = one-way/net mode (buy opens long, sell opens short)
  const body = JSON.stringify({
    instId: p.pair,
    tdMode: "cross",
    side: p.direction,
    posSide: "net",
    ordType: "limit",
    sz: p.quantity,
    px: p.entryPrice,
    tpTriggerPx: p.tp,
    tpOrdPx: p.tp,
    slTriggerPx: p.sl,
    slOrdPx: p.sl,
    tpTriggerPxType: "mark",
    slTriggerPxType: "mark",
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
        "x-simulated-trading": "0",
      },
    },
  );

  if (data.code !== "0") throw new Error(data.msg || "OKX order failed.");
  const result = data.data[0];
  if (result?.sCode !== "0")
    throw new Error(result?.sMsg || "OKX order error.");
  return { orderId: result.ordId, raw: data };
}

async function placeBitgetOrder(
  p: PlaceOrderParams,
): Promise<PlacedOrderResult> {
  const { apiKey, apiSecret, passphrase } = p.credentials;
  if (!passphrase) throw new Error("Bitget requires a passphrase.");

  const timestamp = Date.now().toString();
  const method = "POST";
  // USDT-M perpetual futures endpoint
  const path = "/api/v2/mix/order/place-order";

  // side "buy" opens a long, "sell" opens a short in one-way/net mode
  // tradeSide "open" = opening a new position
  const body = JSON.stringify({
    symbol: p.pair,
    productType: "USDT-FUTURES",
    marginMode: "crossed",
    marginCoin: "USDT",
    side: p.direction,
    tradeSide: "open",
    orderType: "limit",
    force: "gtc",
    price: p.entryPrice,
    size: p.quantity,
    presetStopSurplusPrice: p.tp,
    presetStopLossPrice: p.sl,
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
    "https://api.bitget.com" + path,
    body,
    {
      headers: {
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
  return { orderId: data.data.orderId, raw: data };
}

// ─── Order Status Checkers (Futures) ─────────────────────────────────────────

async function getBinanceOrderStatus(
  credentials: RawCredentials,
  pair: string,
  orderId: string,
): Promise<OrderStatusResult> {
  const { apiKey, apiSecret } = credentials;
  const baseUrl =
    process.env.BINANCE_FUTURES_URL ?? "https://testnet.binancefuture.com";

  const { data: timeData } = await http.get(`${baseUrl}/fapi/v1/time`);
  const ts = timeData.serverTime as number;
  const qs = `symbol=${pair}&orderId=${orderId}&timestamp=${ts}`;
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
  const cumQuote = parseFloat(data.cumQuote ?? "0");
  const averageFillPrice =
    executedQty > 0 && cumQuote > 0
      ? String(cumQuote / executedQty)
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
  const baseUrl = process.env.BYBIT_TEST_API_URL!;
  const timestamp = await getBybitTimestamp(baseUrl);
  const recvWindow = "5000";

  // category: "linear" for USDT perpetuals
  const signPayload = `${timestamp}${apiKey}${recvWindow}category=linear&orderId=${orderId}&symbol=${pair}`;
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
      params: { category: "linear", orderId, symbol: pair },
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

  const timestamp = new Date().toISOString();
  const method = "GET";
  // instId is the SWAP instrument e.g. "BTC-USDT-SWAP"
  const path = `/api/v5/trade/order?instId=${pair}&ordId=${orderId}`;
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
        "x-simulated-trading": "0",
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

  const timestamp = Date.now().toString();
  const method = "GET";
  // Futures order detail endpoint
  const path = `/api/v2/mix/order/detail?symbol=${pair}&orderId=${orderId}&productType=USDT-FUTURES`;
  const signPayload = timestamp + method + path;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("base64");

  interface BitgetStatusResponse {
    code: string;
    data: { state: string; priceAvg: string };
  }

  const { data } = await http.get<BitgetStatusResponse>(
    "https://api.bitget.com" + path,
    {
      headers: {
        "ACCESS-KEY": apiKey,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": passphrase,
        "Content-Type": "application/json",
      },
    },
  );

  if (data.code !== "00000") throw new Error("Bitget order status error");

  const order = data.data;
  if (!order) throw new Error("Order not found on Bitget.");

  const statusMap: Record<string, OrderStatusResult["status"]> = {
    full_fill: "filled",
    partial_fill: "pending",
    cancelled: "cancelled",
    live: "pending",
    not_trigger: "pending",
  };

  return {
    status: statusMap[order.state] ?? "pending",
    filledPrice: order.priceAvg || null,
    raw: data,
  };
}

// ─── Market Price Fetchers (Futures Mark Price) ───────────────────────────────
//
// Mark price is the correct reference for futures — TP/SL triggers and entry
// deviation checks should all compare against mark price, not last traded price.
//
// Binance  → /fapi/v1/premiumIndex          markPrice field
// Bybit    → /v5/market/tickers             category: linear, markPrice field
// OKX      → /api/v5/public/mark-price      instType: SWAP
// Bitget   → /api/v2/mix/market/symbol-price  productType: USDT-FUTURES

async function getBinanceCurrentPrice(
  pair: string,
): Promise<CurrentPriceResult> {
  const baseUrl =
    process.env.BINANCE_FUTURES_URL ?? "https://testnet.binancefuture.com";
  const { data } = await http.get(`${baseUrl}/fapi/v1/premiumIndex`, {
    params: { symbol: pair },
  });

  if (!data?.markPrice)
    throw new Error("Binance returned an invalid futures mark price.");
  return { price: String(data.markPrice), raw: data };
}

async function getBybitCurrentPrice(pair: string): Promise<CurrentPriceResult> {
  const baseUrl = process.env.BYBIT_TEST_API_URL!;
  const { data } = await http.get(`${baseUrl}/v5/market/tickers`, {
    params: { category: "linear", symbol: pair },
  });

  if (data.retCode !== 0)
    throw new Error(data.retMsg || "Bybit ticker failed.");
  const ticker = data.result?.list?.[0];
  if (!ticker?.markPrice)
    throw new Error("Bybit returned an invalid futures mark price.");

  return { price: String(ticker.markPrice), raw: data };
}

async function getOkxCurrentPrice(pair: string): Promise<CurrentPriceResult> {
  // pair must be a SWAP instrument e.g. "BTC-USDT-SWAP"
  const { data } = await http.get(
    "https://www.okx.com/api/v5/public/mark-price",
    { params: { instType: "SWAP", instId: pair } },
  );

  if (data.code !== "0") throw new Error(data.msg || "OKX mark price failed.");
  const ticker = data.data?.[0];
  if (!ticker?.markPx)
    throw new Error("OKX returned an invalid futures mark price.");

  return { price: String(ticker.markPx), raw: data };
}

async function getBitgetCurrentPrice(
  pair: string,
): Promise<CurrentPriceResult> {
  const { data } = await http.get(
    "https://api.bitget.com/api/v2/mix/market/symbol-price",
    { params: { symbol: pair, productType: "USDT-FUTURES" } },
  );

  if (data.code !== "00000")
    throw new Error(data.msg || "Bitget futures mark price failed.");
  const ticker = data.data?.[0];
  if (!ticker?.markPrice)
    throw new Error("Bitget returned an invalid futures mark price.");

  return { price: String(ticker.markPrice), raw: data };
}

// ─── Registries ───────────────────────────────────────────────────────────────

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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Places a futures limit order with TP/SL on the given exchange.
 * direction "buy" = open long position, "sell" = open short position.
 */
export async function placeOrder(
  exchange: ExchangeId,
  params: PlaceOrderParams,
): Promise<PlacedOrderResult> {
  try {
    return await orderPlacer[exchange](params);
  } catch (err) {
    throw normalizeError(err);
  }
}

/**
 * Checks the current status of a previously placed futures order.
 * Used by the polling job to confirm fills and resolve trade results.
 */
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

/**
 * Returns the current futures mark price for a trading pair.
 * Mark price is used for TP/SL triggers and entry deviation checks.
 */
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
