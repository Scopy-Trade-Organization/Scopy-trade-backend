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
    const timestamp = Date.now().toString();
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
      process.env.BYBIT_TEST_API_URL + "/v5/user/query-api",
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
      (info.permissions?.ContractTrade?.length ?? 0) > 0 ||
      (info.permissions?.SpotTrade?.length ?? 0) > 0;
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
        "x-simulated-trading": "0",
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
      "https://api.bitget.com" + path,
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
  status: "open" | "closed" | "cancelled" | "failed";
  filledPrice: string | null;
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

  const timestamp = Date.now().toString();
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
    FILLED: "closed",
    CANCELED: "cancelled",
    REJECTED: "failed",
    EXPIRED: "cancelled",
    NEW: "open",
    PARTIALLY_FILLED: "open",
  };

  return {
    status: statusMap[data.status] ?? "open",
    filledPrice: data.avgPrice || data.price || null,
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
  const timestamp = Date.now().toString();
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
    Filled: "closed",
    Cancelled: "cancelled",
    Rejected: "failed",
    New: "open",
    PartiallyFilled: "open",
  };

  return {
    status: statusMap[order.orderStatus] ?? "open",
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
        "x-simulated-trading": "0",
      },
    },
  );

  const order = data.data[0];
  if (!order) throw new Error("Order not found on OKX.");

  const statusMap: Record<string, OrderStatusResult["status"]> = {
    filled: "closed",
    canceled: "cancelled",
    live: "open",
    partially_filled: "open",
  };

  return {
    status: statusMap[order.state] ?? "open",
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

  const order = data.data[0];
  if (!order) throw new Error("Order not found on Bitget.");

  const statusMap: Record<string, OrderStatusResult["status"]> = {
    full_fill: "closed",
    partial_fill: "open",
    cancelled: "cancelled",
    live: "open",
  };

  return {
    status: statusMap[order.status] ?? "open",
    filledPrice: order.priceAvg || null,
    raw: data,
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
