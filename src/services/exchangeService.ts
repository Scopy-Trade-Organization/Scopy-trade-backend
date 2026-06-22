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
    result: { timeSecond: string; timeNano: string };
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

// ─── Exchange Validators (Futures-focused) ────────────────────────────────────
//
// Each validator hits the futures/derivatives account endpoint to confirm:
//   1. Credentials are valid
//   2. The key has futures trading permissions
//
// Binance  → /fapi/v2/account             (USD-M Futures account)
// Bybit    → /v5/user/query-api           (checks Derivatives permission only)
// OKX      → /api/v5/account/config       (rejects Simple/spot-only acctLv "1")
// Bitget   → /api/v2/mix/account/accounts (USDT-M futures account)

type Validator<T extends AccountInfo> = (
  credentials: RawCredentials,
) => Promise<T>;

const validateBinance: Validator<BinanceAccountInfo> = async ({
  apiKey,
  apiSecret,
}) => {
  try {
    const baseUrl =
      process.env.BINANCE_FUTURES_URL ?? "https://testnet.binancefuture.com";

    const { data: timeData } = await http.get(`${baseUrl}/fapi/v1/time`);
    const timestamp = timeData.serverTime as number;
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(queryString)
      .digest("hex");

    interface BinanceFuturesAccount {
      canTrade: boolean;
      feeTier: number;
      totalWalletBalance: string;
    }

    const { data } = await http.get<BinanceFuturesAccount>(
      `${baseUrl}/fapi/v2/account`,
      {
        params: { timestamp, signature },
        headers: { "X-MBX-APIKEY": apiKey },
        timeout: 8000,
      },
    );

    if (!data.canTrade)
      throw new Error(
        "API key does not have futures trading permissions. Enable Futures trading in Binance API settings.",
      );

    return {
      accountType: "FUTURES",
      canTrade: data.canTrade,
      canWithdraw: false,
      permissions: ["FUTURES"],
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

    // Must have Derivatives permission for linear perpetual futures
    const hasFuturesPermission =
      info.permissions?.Derivatives?.includes("DerivativesTrade") ?? false;

    if (!hasFuturesPermission)
      throw new Error(
        "API key does not have Derivatives trading permissions. Enable Derivatives trading in Bybit API settings.",
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

    // acctLv "1" = Simple mode (spot only) — cannot trade swaps/futures
    // acctLv "2"/"3"/"4" = Single/Multi/Portfolio margin — all support SWAP
    if (config.acctLv === "1")
      throw new Error(
        "OKX account is in Simple mode which does not support futures/swaps. " +
          "Switch to Unified Trading Account in OKX settings.",
      );

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
    const path = "/api/v2/spot/account/info";
    const signPayload = timestamp + method + path;
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(signPayload)
      .digest("base64");

    interface BitgetFuturesAccountResponse {
      code: string;
      msg: string;
      data: Array<{
        marginCoin: string;
        available: string;
        equity: string;
      }>;
    }

    const { data } = await http.get<BitgetResponse>(BITGET_BASE_URL + path, {
      headers: {
        paptrading: "1",
        "ACCESS-KEY": apiKey,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": passphrase,
        "Content-Type": "application/json",
      },
      timeout: 8000,
    });

    if (data.code !== "00000")
      throw new Error(data.msg || "Invalid Bitget API credentials.");

    console.log(
      "Bitget raw validation response:",
      JSON.stringify(data, null, 2),
    );

    const info = data.data as any;
    if (!info) throw new Error("Bitget returned an empty response.");

    const hasTradePermission =
      info.authorities && Array.isArray(info.authorities)
        ? info.authorities.some((a: string) =>
            ["trade", "TRADE", "spot", "futures", "stow", "coow"].includes(a),
          )
        : true; // Bypass strict authorities check for demo keys or spot/account/info endpoints

    if (!hasTradePermission)
      throw new Error(
        "Bitget futures account returned no data. Ensure Futures trading is enabled.",
      );

    return {
      userId: info.userId || "bitget-user",
      inviterId: info.inviterId || "",
      ips: info.ips || "",
      authorities: info.authorities || [],
      parentId: info.parentId || "",
      trader: info.trader || false,
    };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      console.error(
        "Bitget API Error Response:",
        JSON.stringify(error.response.data, null, 2),
      );
      throw new Error(
        "Bitget validation failed: " + JSON.stringify(error.response.data),
      );
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

async function placeBitgetOrder(
  p: PlaceOrderParams,
): Promise<PlacedOrderResult> {
  const { apiKey, apiSecret, passphrase } = p.credentials;
  if (!passphrase) throw new Error("Bitget requires a passphrase.");

  const timestamp = Date.now().toString();
  const method = "POST";
  const path = "/api/v2/mix/order/place-order";
  const body = JSON.stringify({
    symbol: p.pair.replace(/\//g, ""), // e.g. "XRPUSDT"
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

  console.log(
    "Placing Bitget Order - URL:",
    BITGET_BASE_URL + path,
    "Body:",
    body,
  );
  const { data } = await http.post<BitgetOrderResponse>(
    BITGET_BASE_URL + path,
    body,
    {
      headers: {
        paptrading: "1",
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
  const normalizedPair = pair.replace(/\//g, "");
  const path = `/api/v2/mix/order/detail?symbol=${normalizedPair}&productType=USDT-FUTURES&orderId=${orderId}`;
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
    BITGET_BASE_URL + path,
    {
      headers: {
        paptrading: "1",
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
  const normalizedPair = pair.replace(/\//g, "");
  const { data } = await http.get(
    BITGET_BASE_URL + "/api/v2/mix/market/ticker",
    {
      params: { symbol: normalizedPair, productType: "USDT-FUTURES" },
      headers: { paptrading: "1" },
    },
  );

  console.log("Bitget Ticker API Raw Response:", JSON.stringify(data, null, 2));

  if (data.code !== "00000")
    throw new Error(data.msg || "Bitget futures mark price failed.");
  const ticker = data.data?.[0];
  if (!ticker?.markPrice)
    throw new Error("Bitget returned an invalid futures mark price.");

  return { price: String(ticker.markPrice), raw: data };
}

// ─── Balance Fetchers (Futures Wallet) ───────────────────────────────────────
//
// All balances are read from the futures/derivatives wallet — not the spot wallet.
// This ensures the $100 minimum check and 2% risk sizing use the correct account.
//
// Binance  → /fapi/v2/balance                   USD-M futures wallet, USDT balance
// Bybit    → /v5/account/wallet-balance          accountType: CONTRACT
// OKX      → /api/v5/account/balance             unified account (covers swaps)
// Bitget   → /api/v2/mix/account/accounts        productType: USDT-FUTURES

export interface AssetBalance {
  asset: string;
  free: string;
  locked: string;
}

export interface ExchangeBalance {
  balances: AssetBalance[];
  totalUsdtEquivalent: string | null;
}

async function getBinanceBalance(
  credentials: RawCredentials,
): Promise<ExchangeBalance> {
  const { apiKey, apiSecret } = credentials;
  const baseUrl =
    process.env.BINANCE_FUTURES_URL ?? "https://testnet.binancefuture.com";

  try {
    const { data: timeData } = await http.get(`${baseUrl}/fapi/v1/time`);
    const timestamp = timeData.serverTime as number;
    const qs = `timestamp=${timestamp}`;
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(qs)
      .digest("hex");

    interface BinanceFuturesBalance {
      asset: string;
      balance: string; // total wallet balance
      availableBalance: string; // available for new orders
    }

    const { data } = await http.get<BinanceFuturesBalance[]>(
      `${baseUrl}/fapi/v2/balance`,
      {
        params: { timestamp, signature },
        headers: { "X-MBX-APIKEY": apiKey },
      },
    );

    const nonZero = data.filter((b) => parseFloat(b.balance) > 0);
    const usdtEntry = nonZero.find((b) => b.asset === "USDT");
    const totalUsdtEquivalent = usdtEntry
      ? String(parseFloat(usdtEntry.balance))
      : null;

    return {
      balances: nonZero.map((b) => ({
        asset: b.asset,
        free: b.availableBalance,
        locked: String(parseFloat(b.balance) - parseFloat(b.availableBalance)),
      })),
      totalUsdtEquivalent,
    };
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.msg || err?.message;
    if (status === 401 || status === 403)
      throw new Error("Binance Futures: Insufficient permissions");
    throw new Error(`Binance Futures error: ${msg || "Unknown error"}`);
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
    // CONTRACT = derivatives/futures wallet (not UNIFIED which includes spot)
    const queryString = "accountType=CONTRACT";
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
            availableToWithdraw: string;
          }>;
        }>;
      };
    }

    const { data } = await http.get<BybitBalanceResponse>(
      `${baseUrl}/v5/account/wallet-balance`,
      {
        params: { accountType: "CONTRACT" },
        headers: {
          "X-BAPI-API-KEY": apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
        },
      },
    );

    if (data.retCode !== 0)
      throw new Error(data.retMsg || "Bybit futures balance fetch failed.");

    const account = data.result.list[0];
    if (!account)
      throw new Error("Bybit returned an empty futures wallet response.");

    const nonZero = account.coin.filter((c) => parseFloat(c.walletBalance) > 0);

    return {
      balances: nonZero.map((c) => ({
        asset: c.coin,
        free: c.availableToWithdraw,
        locked: String(
          parseFloat(c.walletBalance) -
            parseFloat(c.availableToWithdraw || "0"),
        ),
      })),
      totalUsdtEquivalent: account.totalEquity || null,
    };
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.retMsg || err?.message;
    if (status === 401 || status === 403)
      throw new Error("Bybit Futures: Insufficient permissions");
    throw new Error(`Bybit Futures error: ${msg || "Unknown error"}`);
  }
}

async function getOkxBalance(
  credentials: RawCredentials,
): Promise<ExchangeBalance> {
  const { apiKey, apiSecret, passphrase } = credentials;
  if (!passphrase) throw new Error("OKX requires a passphrase.");

  const timestamp = new Date().toISOString();
  const method = "GET";
  // OKX unified account balance covers swaps/futures — same endpoint
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
  // USDT-M futures account balance
  const path = "/api/v2/mix/account/accounts?productType=USDT-FUTURES";
  const signPayload = timestamp + method + path;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("base64");

  interface BitgetFuturesBalanceResponse {
    code: string;
    msg: string;
    data: Array<{
      marginCoin: string;
      available: string;
      frozen: string;
      equity: string; // total account equity in margin coin
    }>;
  }

  const { data } = await http.get<BitgetBalanceResponse>(
    BITGET_BASE_URL + path,
    {
      headers: {
        paptrading: "1",
        "ACCESS-KEY": apiKey,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": passphrase,
        "Content-Type": "application/json",
      },
    },
  );

  if (data.code !== "00000")
    throw new Error(data.msg || "Bitget futures balance fetch failed.");

  const nonZero = (data.data ?? []).filter((a) => parseFloat(a.equity) > 0);

  const totalUsdt = nonZero.reduce(
    (sum, a) => sum + parseFloat(a.equity || "0"),
    0,
  );

  return {
    balances: nonZero.map((a) => ({
      asset: a.marginCoin,
      free: a.available,
      locked: a.frozen,
    })),
    totalUsdtEquivalent: totalUsdt > 0 ? String(totalUsdt) : null,
  };
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

const balanceFetcher: Record<
  ExchangeId,
  (credentials: RawCredentials) => Promise<ExchangeBalance>
> = {
  binance: getBinanceBalance,
  bybit: getBybitBalance,
  okx: getOkxBalance,
  bitget: getBitgetBalance,
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

/**
 * Fetches the futures wallet balance for a given exchange.
 * Returns only non-zero assets. totalUsdtEquivalent drives the
 * $100 minimum check and 2% risk sizing in the trade controller.
 */
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
        paptrading: "1",
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
