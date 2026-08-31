import crypto from "crypto";
import { RawCredentials, ExchangeId } from "../types/index.js";
import { http, normalizeError } from "./exchangeConnectionService.js";
import { isBitgetDemo, isOkxDemo } from "./exchangeEnvironment.js";

const BITGET_BASE_URL = process.env.BITGET_BASE_URL || "https://api.bitget.com";

// A withdrawal moves real funds and must never be silently re-sent by the HTTP
// layer: a network blip or 5xx after the exchange already accepted the request
// would double-pay. Disable axios-retry per-request for every withdrawal call.
const NO_RETRY = { "axios-retry": { retries: 0 } } as const;

export type UsdtNetwork = "TRON" | "ETHEREUM" | "BSC" | "POLYGON" | "ARBITRUM";

// Demo destinations requested for this implementation. Replace these before
// enabling live settlement; dry-run mode is the safe default.
export const PLATFORM_USDT_WALLETS: Record<UsdtNetwork, string> = {
  TRON: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE",
  ETHEREUM: "0x1111111111111111111111111111111111111111",
  BSC: "0x2222222222222222222222222222222222222222",
  POLYGON: "0x3333333333333333333333333333333333333333",
  ARBITRUM: "0x4444444444444444444444444444444444444444",
};

export function getPlatformWallet(): { network: UsdtNetwork; address: string } {
  const requested = process.env.PLATFORM_USDT_NETWORK?.toUpperCase() as UsdtNetwork;
  const network = requested in PLATFORM_USDT_WALLETS ? requested : "TRON";
  return { network, address: PLATFORM_USDT_WALLETS[network] };
}

const networkCodes: Record<UsdtNetwork, { binance: string; bybit: string }> = {
  TRON: { binance: "TRX", bybit: "TRX" },
  ETHEREUM: { binance: "ETH", bybit: "ETH" },
  BSC: { binance: "BSC", bybit: "BSC" },
  POLYGON: { binance: "MATIC", bybit: "MATIC" },
  ARBITRUM: { binance: "ARBITRUM", bybit: "ARBI" },
};

async function withdrawBinance(
  credentials: RawCredentials,
  amount: string,
  destinationAddress: string,
  network: UsdtNetwork,
  requestId: string,
): Promise<{ transactionId: string; raw: any }> {
  const timestamp = Date.now();
  const query = new URLSearchParams({
    coin: "USDT",
    address: destinationAddress,
    amount,
    network: networkCodes[network].binance,
    withdrawOrderId: requestId,
    timestamp: String(timestamp),
  }).toString();
  const signature = crypto.createHmac("sha256", credentials.apiSecret).update(query).digest("hex");
  const baseUrl = process.env.BINANCE_SPOT_API_URL || "https://api.binance.com";
  const { data } = await http.post(`${baseUrl}/sapi/v1/capital/withdraw/apply?${query}&signature=${signature}`, null, {
    headers: { "X-MBX-APIKEY": credentials.apiKey },
    ...NO_RETRY,
  });
  return { transactionId: String(data.id || requestId), raw: data };
}

async function withdrawBybit(
  credentials: RawCredentials,
  amount: string,
  destinationAddress: string,
  network: UsdtNetwork,
  requestId: string,
): Promise<{ transactionId: string; raw: any }> {
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const body = JSON.stringify({
    coin: "USDT",
    chain: networkCodes[network].bybit,
    address: destinationAddress,
    amount,
    timestamp: Number(timestamp),
    forceChain: 1,
    accountType: "FUND",
    requestId,
  });
  const signature = crypto
    .createHmac("sha256", credentials.apiSecret)
    .update(timestamp + credentials.apiKey + recvWindow + body)
    .digest("hex");
  const baseUrl = process.env.BYBIT_API_URL || "https://api.bybit.com";
  const { data } = await http.post(`${baseUrl}/v5/asset/withdraw/create`, body, {
    headers: {
      "X-BAPI-API-KEY": credentials.apiKey,
      "X-BAPI-SIGN": signature,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "Content-Type": "application/json",
    },
    ...NO_RETRY,
  });
  if (data.retCode !== 0) throw new Error(data.retMsg || "Bybit withdrawal failed.");
  return { transactionId: String(data.result?.id || requestId), raw: data };
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
        ...(isBitgetDemo() ? { paptrading: "1" } : {}),
        "ACCESS-KEY": apiKey,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": passphrase,
        "Content-Type": "application/json",
      },
      ...NO_RETRY,
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
        ...(isOkxDemo() ? { "x-simulated-trading": "1" } : {}),
      },
      ...NO_RETRY,
    },
  );

  if (data.code !== "0") {
    throw new Error(data.msg || "OKX withdrawal failed.");
  }

  const wdId = data.data?.[0]?.wdId || "unknown";
  return { transactionId: wdId, raw: data };
}

// ─── Public Withdrawal API ────────────────────────────────────────────────────

export async function withdrawUsdt(
  exchange: ExchangeId,
  credentials: RawCredentials,
  amount: string,
  destinationAddress: string,
  network: UsdtNetwork = "TRON",
  requestId: string = crypto.randomUUID(),
): Promise<{ transactionId: string; raw: any }> {
  try {
    if (process.env.PROFIT_WITHDRAWAL_MODE !== "live") {
      return {
        transactionId: `dry-run-${requestId}`,
        raw: { mode: "dry-run", exchange, amount, destinationAddress, network },
      };
    }
    if (exchange === "binance") {
      return await withdrawBinance(credentials, amount, destinationAddress, network, requestId);
    } else if (exchange === "bybit") {
      return await withdrawBybit(credentials, amount, destinationAddress, network, requestId);
    }
    if (exchange === "okx") {
      return await withdrawOkx(credentials, amount, destinationAddress);
    } else if (exchange === "bitget") {
      return await withdrawBitget(credentials, amount, destinationAddress);
    } else {
      throw new Error(`Withdrawal is not supported for ${exchange}.`);
    }
  } catch (err) {
    const error = normalizeError(err);
    (error as any).exchange = exchange;
    throw error;
  }
}
