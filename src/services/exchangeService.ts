import crypto from "crypto";
import axios from "axios";
import {
  RawCredentials,
  ExchangeId,
  EncryptedCredentials,
  AccountInfo,
  BinanceAccountInfo,
  BybitAccountInfo,
  OkxAccountInfo,
  BitgetAccountInfo,
} from "../types/index.js";
import axiosRetry from "axios-retry";

const BITGET_BASE_URL = process.env.BITGET_BASE_URL || "https://api.bitget.com";

export const http = axios.create({
  timeout: 8000,
});

axiosRetry(http, {
  retries: 2,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) =>
    axiosRetry.isNetworkError(error) || (error.response?.status ?? 0) >= 500,
});

function normalizeError(err: unknown): Error {
  if (axios.isAxiosError(err)) {
    console.log("EXCHANGE ERROR:", {
      status: err.response?.status,
      data: err.response?.data,
      headers: err.response?.headers,
    });
    return new Error(
      JSON.stringify({
        status: err.response?.status,
        data: err.response?.data,
      }),
    );
  }
  if (err instanceof Error) return err;
  return new Error("Unknown error occurred");
}

async function getBybitTimestamp(baseUrl: string): Promise<string> {
  interface BybitTimeResponse {
    retCode: number;
    retMsg: string;
    result: {
      timeSecond: string;
      timeNano: string;
    };
    time?: number;
  }

  const { data } = await http.get<BybitTimeResponse>(
    `${baseUrl}/v5/market/time`,
  );

  if (data.retCode !== 0) {
    throw new Error(data.retMsg || "Failed to fetch Bybit server time.");
  }

  if (typeof data.time === "number") return String(data.time);

  const timeSecond = Number(data.result?.timeSecond);
  if (!Number.isFinite(timeSecond)) {
    throw new Error("Bybit returned an invalid server time.");
  }

  return String(timeSecond * 1000);
}

// ─── Encryption Helpers ────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm" as const;

function getEncryptionKey(): Buffer {
  const hex = process.env.EXCHANGE_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "EXCHANGE_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).",
    );
  }
  return Buffer.from(hex, "hex");
}

function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

function decrypt(stored: string): string {
  const key = getEncryptionKey();
  const parts = stored.split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted value.");
  const [ivHex, authTagHex, encryptedHex] = parts as [string, string, string];
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

// ─── Exchange Validators ───────────────────────────────────────────────────────

type Validator<T extends AccountInfo> = (
  credentials: RawCredentials,
) => Promise<T>;

const validateBinance: Validator<BinanceAccountInfo> = async ({
  apiKey,
  apiSecret,
}) => {
  try {
    const { data: timeData } = await http.get(
      process.env.BINANCE_TEST_API_URL + "/api/v3/time",
    );
    const timestamp = timeData.serverTime;
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(queryString)
      .digest("hex");

    const { data } = await http.get<BinanceAccountInfo & { canTrade: boolean }>(
      process.env.BINANCE_TEST_API_URL + "/api/v3/account",
      {
        params: { timestamp, signature },
        headers: { "X-MBX-APIKEY": apiKey },
        timeout: 8000,
      },
    );
    if (!data.canTrade)
      throw new Error("API key does not have trading permissions enabled.");
    return {
      accountType: data.accountType,
      canTrade: data.canTrade,
      canWithdraw: data.canWithdraw,
      permissions: data.permissions,
    };
  } catch (err) {
    throw normalizeError(err);
  }
};

const validateBybit: Validator<BybitAccountInfo> = async ({
  apiKey,
  apiSecret,
}) => {
  try {
    const baseUrl = process.env.BYBIT_TEST_API_URL!;
    const timestamp = await getBybitTimestamp(baseUrl);
    const recvWindow = "5000";
    const signPayload = timestamp + apiKey + recvWindow;
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(signPayload)
      .digest("hex");

    interface BybitResponse {
      retCode: number;
      retMsg: string;
      result: {
        accountType: string;
        permissions: Record<string, string[]>;
        readOnly: number;
      };
    }

    const { data } = await http.get<BybitResponse>(
      `${baseUrl}/v5/user/query-api`,
      {
        headers: {
          "X-BAPI-API-KEY": apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
        },
        timeout: 8000,
      },
    );
    if (data.retCode !== 0)
      throw new Error(data.retMsg || "Invalid Bybit API credentials.");

    const info = data.result;

    const hasTradePermission =
      (info.permissions?.Spot?.includes("SpotTrade") ?? false) ||
      (info.permissions?.Derivatives?.includes("DerivativesTrade") ?? false);

    if (!hasTradePermission)
      throw new Error(
        "API key does not have trading permissions. Enable Spot or Derivatives trading in Bybit API settings.",
      );
    return {
      accountType: info.accountType,
      permissions: info.permissions,
      readOnly: info.readOnly === 1,
    };
  } catch (error) {
    throw normalizeError(error);
  }
};

const validateOkx: Validator<OkxAccountInfo> = async ({
  apiKey,
  apiSecret,
  passphrase,
}) => {
  try {
    if (!passphrase)
      throw new Error("OKX requires a passphrase. Please provide it.");
    const timestamp = new Date().toISOString();
    const method = "GET";
    const path = "/api/v5/account/config";
    const signPayload = timestamp + method + path;
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(signPayload)
      .digest("base64");

    interface OkxResponse {
      code: string;
      msg: string;
      data: Array<{ acctLv: string; posMode: string; uid: string }>;
    }

    const { data } = await http.get<OkxResponse>("https://www.okx.com" + path, {
      headers: {
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": passphrase,
        "x-simulated-trading": "1",
      },
      timeout: 8000,
    });
    if (data.code !== "0")
      throw new Error(data.msg || "Invalid OKX API credentials.");

    const config = data.data[0];
    if (!config)
      throw new Error("OKX returned an empty configuration response.");
    return {
      accountLevel: config.acctLv,
      posMode: config.posMode,
      uid: config.uid,
    };
  } catch (error) {
    throw normalizeError(error);
  }
};

const validateBitget: Validator<BitgetAccountInfo> = async ({
  apiKey,
  apiSecret,
  passphrase,
}) => {
  try {
    if (!passphrase)
      throw new Error("Bitget requires a passphrase. Please provide it.");
    const timestamp = Date.now().toString();
    const method = "GET";
    const path = "/api/v2/user/info";
    const signPayload = timestamp + method + path;
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(signPayload)
      .digest("base64");

    interface BitgetResponse {
      code: string;
      msg: string;
      data: {
        userId: string;
        inviterId: string;
        ips: string;
        authorities: string[];
        parentId: string;
        trader: boolean;
      };
    }

    const { data } = await http.get<BitgetResponse>(
      BITGET_BASE_URL + path,
      {
        headers: {
          "ACCESS-KEY": apiKey,
          "ACCESS-SIGN": signature,
          "ACCESS-TIMESTAMP": timestamp,
          "ACCESS-PASSPHRASE": passphrase,
          "Content-Type": "application/json",
        },
        timeout: 8000,
      },
    );
    if (data.code !== "00000")
      throw new Error(data.msg || "Invalid Bitget API credentials.");

    const info = data.data;
    if (!info) throw new Error("Bitget returned an empty response.");

    const hasTradePermission = info.authorities?.some((a) =>
      ["trade", "TRADE", "spot", "futures"].includes(a),
    );
    if (!hasTradePermission)
      throw new Error(
        "API key does not have trading permissions. Enable Spot or Futures trading in Bitget API settings.",
      );
    return {
      userId: info.userId,
      inviterId: info.inviterId,
      ips: info.ips,
      authorities: info.authorities,
      parentId: info.parentId,
      trader: info.trader,
    };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      console.error("Bitget API Error Response:", JSON.stringify(error.response.data, null, 2));
      throw new Error("Bitget validation failed: " + JSON.stringify(error.response.data));
    }
    throw normalizeError(error);
  }
};

// ─── Validator Registry ───────────────────────────────────────────────────────

const validators: Record<ExchangeId, Validator<AccountInfo>> = {
  binance: validateBinance,
  bybit: validateBybit,
  okx: validateOkx,
  bitget: validateBitget,
};

// ─── Public Credential API ────────────────────────────────────────────────────

export async function validateCredentials(
  exchange: ExchangeId,
  credentials: RawCredentials,
): Promise<AccountInfo> {
  const validator = validators[exchange];
  return validator(credentials);
}

export function encryptCredentials(
  exchange: ExchangeId,
  credentials: RawCredentials,
): EncryptedCredentials {
  const result: EncryptedCredentials = {
    exchange,
    apiKey: encrypt(credentials.apiKey),
    apiSecret: encrypt(credentials.apiSecret),
  };
  if (credentials.passphrase) {
    result.passphrase = encrypt(credentials.passphrase);
  }
  return result;
}

export function decryptCredentials(
  stored: EncryptedCredentials,
): RawCredentials & { exchange: ExchangeId } {
  const result: RawCredentials & { exchange: ExchangeId } = {
    exchange: stored.exchange,
    apiKey: decrypt(stored.apiKey),
    apiSecret: decrypt(stored.apiSecret),
  };
  if (stored.passphrase) {
    result.passphrase = decrypt(stored.passphrase);
  }
  return result;
}

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

// ─── Order Placement ──────────────────────────────────────────────────────────

// ── Binance Spot — places limit order; TP/SL via OCO is a follow-on order
// For simplicity we attach a stop-limit immediately after entry using STOP_LOSS_LIMIT
// Production apps typically use the OCO endpoint once fill is confirmed.
async function placeBinanceOrder(
  p: PlaceOrderParams,
): Promise<PlacedOrderResult> {
  const { apiKey, apiSecret } = p.credentials;
  const baseUrl = process.env.BINANCE_TEST_API_URL!;

  const getTimestamp = async () => {
    const { data } = await http.get(`${baseUrl}/api/v3/time`);
    return data.serverTime as number;
  };

  const sign = (qs: string) =>
    crypto.createHmac("sha256", apiSecret).update(qs).digest("hex");

  // 1. Place the limit entry order
  const ts = await getTimestamp();
  const side = p.direction.toUpperCase(); // BUY | SELL
  const entryQs = `symbol=${p.pair}&side=${side}&type=LIMIT&timeInForce=GTC&quantity=${p.quantity}&price=${p.entryPrice}&timestamp=${ts}`;
  const { data: orderData } = await http.post(`${baseUrl}/api/v3/order`, null, {
    params: {
      ...Object.fromEntries(new URLSearchParams(entryQs)),
      signature: sign(entryQs),
    },
    headers: { "X-MBX-APIKEY": apiKey },
  });

  return { orderId: String(orderData.orderId), raw: orderData };
}

async function placeBinanceTpSl(
  params: PlaceOrderParams & { orderId: string },
) {
  // Called after the entry order is confirmed filled.
  // Places an OCO (One-Cancels-the-Other) for TP + SL on the exit side.
  const {
    credentials: { apiKey, apiSecret },
    pair,
    direction,
    quantity,
    tp,
    sl,
  } = params;
  const baseUrl = process.env.BINANCE_TEST_API_URL!;
  const exitSide = direction === "buy" ? "SELL" : "BUY";

  const { data: timeData } = await http.get(`${baseUrl}/api/v3/time`);
  const ts = timeData.serverTime as number;

  const qs =
    `symbol=${pair}&side=${exitSide}&quantity=${quantity}` +
    `&price=${tp}&stopPrice=${sl}&stopLimitPrice=${sl}&stopLimitTimeInForce=GTC` +
    `&timestamp=${ts}`;
  const sig = crypto.createHmac("sha256", apiSecret).update(qs).digest("hex");

  await http.post(`${baseUrl}/api/v3/order/oco`, null, {
    params: { ...Object.fromEntries(new URLSearchParams(qs)), signature: sig },
    headers: { "X-MBX-APIKEY": apiKey },
  });
}

// ── Bybit Spot — places limit order with TP/SL in a single call (v5 supports it)
async function placeBybitOrder(
  p: PlaceOrderParams,
): Promise<PlacedOrderResult> {
  const { apiKey, apiSecret } = p.credentials;
  const baseUrl = process.env.BYBIT_TEST_API_URL!;

  const timestamp = await getBybitTimestamp(baseUrl);
  const recvWindow = "5000";
  const body = JSON.stringify({
    category: "spot",
    symbol: p.pair,
    side: p.direction === "buy" ? "Buy" : "Sell",
    orderType: "Limit",
    qty: p.quantity,
    price: p.entryPrice,
    takeProfit: p.tp,
    stopLoss: p.sl,
    timeInForce: "GTC",
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

// ── OKX — places limit order with attached TP/SL
async function placeOkxOrder(p: PlaceOrderParams): Promise<PlacedOrderResult> {
  const { apiKey, apiSecret, passphrase } = p.credentials;
  if (!passphrase) throw new Error("OKX requires a passphrase.");

  const timestamp = new Date().toISOString();
  const method = "POST";
  const path = "/api/v5/trade/order";
  const body = JSON.stringify({
    instId: p.pair, // e.g. "BTC-USDT"
    tdMode: "cash", // spot
    side: p.direction,
    ordType: "limit",
    sz: p.quantity,
    px: p.entryPrice,
    tpTriggerPx: p.tp,
    tpOrdPx: p.tp,
    slTriggerPx: p.sl,
    slOrdPx: p.sl,
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

// ── Bitget — places limit order
async function placeBitgetOrder(
  p: PlaceOrderParams,
): Promise<PlacedOrderResult> {
  const { apiKey, apiSecret, passphrase } = p.credentials;
  if (!passphrase) throw new Error("Bitget requires a passphrase.");

  const timestamp = Date.now().toString();
  const method = "POST";
  const path = "/api/v2/spot/trade/place-order";
  const body = JSON.stringify({
    symbol: p.pair, // e.g. "BTCUSDT"
    side: p.direction,
    orderType: "limit",
    force: "gtc",
    price: p.entryPrice,
    size: p.quantity,
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

// ─── Order Status Checkers ─────────────────────────────────────────────────────

async function getBinanceOrderStatus(
  credentials: RawCredentials,
  pair: string,
  orderId: string,
): Promise<OrderStatusResult> {
  const { apiKey, apiSecret } = credentials;
  const baseUrl = process.env.BINANCE_TEST_API_URL!;
  const { data: timeData } = await http.get(`${baseUrl}/api/v3/time`);
  const ts = timeData.serverTime as number;
  const qs = `symbol=${pair}&orderId=${orderId}&timestamp=${ts}`;
  const sig = crypto.createHmac("sha256", apiSecret).update(qs).digest("hex");

  const { data } = await http.get(`${baseUrl}/api/v3/order`, {
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
  const baseUrl = process.env.BYBIT_TEST_API_URL!;
  const timestamp = await getBybitTimestamp(baseUrl);
  const recvWindow = "5000";
  const signPayload = `${timestamp}${apiKey}${recvWindow}category=spot&orderId=${orderId}&symbol=${pair}`;
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
      params: { category: "spot", orderId, symbol: pair },
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

  const timestamp = Date.now().toString();
  const method = "GET";
  const path = `/api/v2/spot/trade/orderInfo?symbol=${pair}&orderId=${orderId}`;
  const signPayload = timestamp + method + path;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("base64");

  interface BitgetStatusResponse {
    code: string;
    data: Array<{ status: string; priceAvg: string }>;
  }

  const { data } = await http.get<BitgetStatusResponse>(
    BITGET_BASE_URL + path,
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

  const order = data.data[0];
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
  const baseUrl = process.env.BINANCE_TEST_API_URL!;
  const { data } = await http.get(`${baseUrl}/api/v3/ticker/price`, {
    params: { symbol: pair },
  });

  if (!data?.price) throw new Error("Binance returned an invalid ticker.");
  return { price: String(data.price), raw: data };
}

async function getBybitCurrentPrice(pair: string): Promise<CurrentPriceResult> {
  const baseUrl = process.env.BYBIT_TEST_API_URL!;
  const { data } = await http.get(`${baseUrl}/v5/market/tickers`, {
    params: { category: "spot", symbol: pair },
  });

  if (data.retCode !== 0) throw new Error(data.retMsg || "Bybit ticker failed.");
  const ticker = data.result?.list?.[0];
  if (!ticker?.lastPrice) throw new Error("Bybit returned an invalid ticker.");

  return { price: String(ticker.lastPrice), raw: data };
}

async function getOkxCurrentPrice(pair: string): Promise<CurrentPriceResult> {
  const { data } = await http.get("https://www.okx.com/api/v5/market/ticker", {
    params: { instId: pair },
  });

  if (data.code !== "0") throw new Error(data.msg || "OKX ticker failed.");
  const ticker = data.data?.[0];
  if (!ticker?.last) throw new Error("OKX returned an invalid ticker.");

  return { price: String(ticker.last), raw: data };
}

async function getBitgetCurrentPrice(pair: string): Promise<CurrentPriceResult> {
  const { data } = await http.get(BITGET_BASE_URL + "/api/v2/spot/market/tickers", {
    params: { symbol: pair },
  });

  if (data.code !== "00000")
    throw new Error(data.msg || "Bitget ticker failed.");
  const ticker = data.data?.[0];
  if (!ticker?.lastPr) throw new Error("Bitget returned an invalid ticker.");

  return { price: String(ticker.lastPr), raw: data };
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

// ─── Public Order API ─────────────────────────────────────────────────────────

/**
 * Places a limit order on the given exchange with TP/SL attached where supported.
 * Returns the exchange-native order ID and the raw response for audit storage.
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
 * Checks the current status of a previously placed order.
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

/**
 * Places the Binance TP/SL OCO after an entry order has been confirmed filled.
 * Only needed for Binance; other exchanges attach TP/SL at order creation time.
 */
export async function attachBinanceTpSl(
  params: PlaceOrderParams & { orderId: string },
): Promise<void> {
  try {
    await placeBinanceTpSl(params);
  } catch (err) {
    throw normalizeError(err);
  }
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

// ─── Per-Exchange Balance Fetchers ────────────────────────────────────────────

async function getBinanceBalance(
  credentials: RawCredentials,
): Promise<ExchangeBalance> {
  const { apiKey, apiSecret } = credentials;
  const baseUrl = process.env.BINANCE_TEST_API_URL!;

  try {
    const { data: timeData } = await http.get(`${baseUrl}/api/v3/time`);
    const timestamp = timeData.serverTime as number;

    const qs = `timestamp=${timestamp}`;
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(qs)
      .digest("hex");

    interface BinanceAccountResponse {
      balances: Array<{ asset: string; free: string; locked: string }>;
    }

    const { data } = await http.get<BinanceAccountResponse>(
      `${baseUrl}/api/v3/account`,
      {
        params: { timestamp, signature },
        headers: { "X-MBX-APIKEY": apiKey },
      },
    );

    const nonZero = data.balances.filter(
      (b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0,
    );

    const usdtEntry = nonZero.find(
      (b) => b.asset === "USDT" || b.asset === "BUSD",
    );

    const totalUsdtEquivalent = usdtEntry
      ? String(parseFloat(usdtEntry.free) + parseFloat(usdtEntry.locked))
      : null;

    return {
      balances: nonZero.map((b) => ({
        asset: b.asset,
        free: b.free,
        locked: b.locked,
      })),
      totalUsdtEquivalent,
    };
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.msg || err?.message;

    if (status === 401 || status === 403) {
      throw new Error("Binance: Insufficient permissions");
    }

    if (msg?.toLowerCase?.().includes("permission")) {
      throw new Error(`Binance: ${msg}`);
    }

    throw new Error(`Binance error: ${msg || "Unknown error"}`);
  }
}

async function getBybitBalance(
  credentials: RawCredentials,
): Promise<ExchangeBalance> {
  const { apiKey, apiSecret } = credentials;
  const baseUrl = process.env.BYBIT_TEST_API_URL!;

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

    if (msg?.toLowerCase?.().includes("permission")) {
      throw new Error(`Bybit: ${msg}`);
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
  const path = "/api/v2/spot/account/assets";
  const signPayload = timestamp + method + path;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("base64");

  interface BitgetBalanceResponse {
    code: string;
    msg: string;
    data: Array<{
      coin: string;
      available: string;
      frozen: string;
      locked: string;
      usdtValue: string;
    }>;
  }

  const { data } = await http.get<BitgetBalanceResponse>(
    BITGET_BASE_URL + path,
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
    throw new Error(data.msg || "Bitget balance fetch failed.");

  const nonZero = (data.data ?? []).filter(
    (a) => parseFloat(a.available) > 0 || parseFloat(a.frozen) > 0,
  );

  // Sum USDT values reported natively by Bitget per-asset
  const totalUsdt = nonZero.reduce(
    (sum, a) => sum + parseFloat(a.usdtValue || "0"),
    0,
  );

  return {
    balances: nonZero.map((a) => ({
      asset: a.coin,
      free: a.available,
      locked: String(parseFloat(a.frozen) + parseFloat(a.locked || "0")),
    })),
    totalUsdtEquivalent: totalUsdt > 0 ? String(totalUsdt) : null,
  };
}

// ─── Balance Fetcher Registry ─────────────────────────────────────────────────

const balanceFetcher: Record<
  ExchangeId,
  (credentials: RawCredentials) => Promise<ExchangeBalance>
> = {
  binance: getBinanceBalance,
  bybit: getBybitBalance,
  okx: getOkxBalance,
  bitget: getBitgetBalance,
};

// ─── Public Balance API ───────────────────────────────────────────────────────

/**
 * Fetches the spot wallet balance for a given exchange.
 * Returns only non-zero asset entries to keep the payload lean.
 */
export async function getExchangeBalance(
  exchange: ExchangeId,
  credentials: RawCredentials,
): Promise<ExchangeBalance> {
  try {
    return await balanceFetcher[exchange](credentials);
  } catch (err) {
    const error = normalizeError(err);

    // attach exchange context
    (error as any).exchange = exchange;

    throw error;
  }
}

async function withdrawBitget(
  credentials: RawCredentials,
  amount: string,
  destinationAddress: string,
): Promise<{ transactionId: string; raw: any }> {
  const { apiKey, apiSecret, passphrase } = credentials;
  if (!passphrase) throw new Error("Bitget requires a passphrase.");

  const timestamp = Date.now().toString();
  const method = "POST";
  const path = "/api/v2/wallet/withdrawal";
  const body = JSON.stringify({
    coin: "USDT",
    address: destinationAddress,
    chain: "TRC20",
    amount,
    outerOrderNo: crypto.randomUUID(),
  });

  const signPayload = timestamp + method + path + body;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("base64");

  interface BitgetWithdrawResponse {
    code: string;
    msg: string;
    data: {
      withdrawId: string;
    } | null;
  }

  const { data } = await http.post<BitgetWithdrawResponse>(
    BITGET_BASE_URL + path,
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

  if (data.code !== "00000") {
    throw new Error(data.msg || "Bitget withdrawal failed.");
  }

  const withdrawId = data.data?.withdrawId || "unknown";
  return { transactionId: withdrawId, raw: data };
}

async function withdrawOkx(
  credentials: RawCredentials,
  amount: string,
  destinationAddress: string,
): Promise<{ transactionId: string; raw: any }> {
  const { apiKey, apiSecret, passphrase } = credentials;
  if (!passphrase) throw new Error("OKX requires a passphrase.");

  const timestamp = new Date().toISOString();
  const method = "POST";
  const path = "/api/v5/asset/withdrawal";
  const body = JSON.stringify({
    ccy: "USDT",
    amt: amount,
    dest: "4", // digital wallet address
    toAddr: destinationAddress,
    chain: "USDT-TRC20",
  });

  const signPayload = timestamp + method + path + body;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("base64");

  interface OkxWithdrawResponse {
    code: string;
    msg: string;
    data: Array<{
      wdId: string;
    }>;
  }

  const { data } = await http.post<OkxWithdrawResponse>(
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

  if (data.code !== "0") {
    throw new Error(data.msg || "OKX withdrawal failed.");
  }

  const wdId = data.data?.[0]?.wdId || "unknown";
  return { transactionId: wdId, raw: data };
}

/**
 * Initiates a USDT TRC-20 withdrawal from the given exchange connection.
 * Only supported for OKX and Bitget.
 */
export async function withdrawUsdt(
  exchange: ExchangeId,
  credentials: RawCredentials,
  amount: string,
  destinationAddress: string,
): Promise<{ transactionId: string; raw: any }> {
  try {
    if (exchange === "okx") {
      return await withdrawOkx(credentials, amount, destinationAddress);
    } else if (exchange === "bitget") {
      return await withdrawBitget(credentials, amount, destinationAddress);
    } else {
      throw new Error(`Withdrawal is only supported for OKX and Bitget.`);
    }
  } catch (err) {
    const error = normalizeError(err);
    (error as any).exchange = exchange;
    throw error;
  }
}

