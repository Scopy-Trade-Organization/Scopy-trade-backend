import crypto from "crypto";
import { RawCredentials, ExchangeId } from "../types/index.js";
import { http, normalizeError, getBybitTimestamp } from "./exchangeConnectionService.js";
import {
  getExchangeRestUrl,
  isBitgetDemo,
  isOkxDemo,
  isTestnet,
} from "./exchangeEnvironment.js";
import { isValidTronAddress } from "../helpers/tronAddress.js";

function getBitgetBaseUrl(): string {
  return (process.env.BITGET_API_URL || "https://api.bitget.com").replace(
    /\/+$/,
    "",
  );
}

// A withdrawal moves real funds and must never be silently re-sent by the HTTP
// layer: a network blip or 5xx after the exchange already accepted the request
// would double-pay. Disable axios-retry per-request for every withdrawal call.
const NO_RETRY = { "axios-retry": { retries: 0 } } as const;

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function pollingConfig(): { intervalMs: number; maxAttempts: number } {
  const configuredInterval = Number(process.env.WITHDRAWAL_STATUS_POLL_INTERVAL_MS);
  const configuredAttempts = Number(process.env.WITHDRAWAL_STATUS_POLL_MAX_ATTEMPTS);
  return {
    intervalMs:
      Number.isInteger(configuredInterval) && configuredInterval >= 0
        ? Math.min(configuredInterval, 60_000)
        : 5_000,
    maxAttempts:
      Number.isInteger(configuredAttempts) && configuredAttempts > 0
        ? Math.min(configuredAttempts, 720)
        : 120,
  };
}

export interface WithdrawalResult {
  transactionId: string;
  status: "dry-run" | "submitted" | "success";
  blockchainTransactionId?: string;
  raw: any;
}

export interface WithdrawalPreflight {
  accountType: string;
  availableUsdt: string;
}

/** Reads the balance of the exact account from which each withdrawal API debits. */
export async function getWithdrawalPreflight(
  exchange: ExchangeId,
  credentials: RawCredentials,
): Promise<WithdrawalPreflight> {
  try {
    if (exchange === "binance") {
      const timestamp = Date.now();
      const query = `timestamp=${timestamp}`;
      const signature = crypto.createHmac("sha256", credentials.apiSecret).update(query).digest("hex");
      const baseUrl = process.env.BINANCE_SPOT_API_URL || "https://api.binance.com";
      const { data } = await http.get(`${baseUrl}/api/v3/account?${query}&signature=${signature}`, {
        headers: { "X-MBX-APIKEY": credentials.apiKey },
      });
      const usdt = data.balances?.find((item: any) => item.asset === "USDT");
      return { accountType: String(data.accountType || "SPOT"), availableUsdt: String(usdt?.free || "0") };
    }
    if (exchange === "bybit") {
      const baseUrl = getExchangeRestUrl("bybit");
      const timestamp = await getBybitTimestamp(baseUrl);
      const recvWindow = "5000";
      const query = "coinName=USDT";
      const signature = crypto.createHmac("sha256", credentials.apiSecret)
        .update(timestamp + credentials.apiKey + recvWindow + query).digest("hex");
      const { data } = await http.get(`${baseUrl}/v5/account/withdrawal?${query}`, {
        headers: {
          "X-BAPI-API-KEY": credentials.apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
        },
      });
      if (data.retCode !== 0) throw new Error(data.retMsg || "Bybit withdrawal balance lookup failed.");
      return {
        accountType: "UNIFIED",
        availableUsdt: String(data.result?.availableWithdrawalMap?.USDT || "0"),
      };
    }
    if (exchange === "okx") {
      if (!credentials.passphrase) throw new Error("OKX requires a passphrase.");
      const timestamp = new Date().toISOString();
      const path = "/api/v5/asset/balances?ccy=USDT";
      const signature = crypto.createHmac("sha256", credentials.apiSecret)
        .update(timestamp + "GET" + path).digest("base64");
      const { data } = await http.get(`https://www.okx.com${path}`, {
        headers: {
          "OK-ACCESS-KEY": credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": credentials.passphrase,
          ...(isOkxDemo() ? { "x-simulated-trading": "1" } : {}),
        },
      });
      if (data.code !== "0") throw new Error(data.msg || "OKX funding balance lookup failed.");
      return { accountType: "FUNDING", availableUsdt: String(data.data?.[0]?.availBal || "0") };
    }
    if (!credentials.passphrase) throw new Error("Bitget requires a passphrase.");
    const timestamp = Date.now().toString();
    const path = "/api/v3/account/assets";
    const signature = crypto.createHmac("sha256", credentials.apiSecret)
      .update(timestamp + "GET" + path).digest("base64");
    const { data } = await http.get(`${getBitgetBaseUrl()}${path}`, {
      headers: {
        ...(isBitgetDemo() ? { paptrading: "1" } : {}),
        "ACCESS-KEY": credentials.apiKey,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": credentials.passphrase,
      },
    });
    if (data.code !== "00000") throw new Error(data.msg || "Bitget UTA balance lookup failed.");
    const usdt = data.data?.assets?.find((item: any) => String(item.coin).toUpperCase() === "USDT");
    return { accountType: "UTA", availableUsdt: String(usdt?.available || "0") };
  } catch (error) {
    const normalized = normalizeError(error);
    (normalized as any).exchange = exchange;
    throw normalized;
  }
}

function normalizeRequestId(requestId: string): string {
  if (/^[A-Za-z0-9]{1,32}$/.test(requestId)) return requestId;
  return crypto.createHash("sha256").update(requestId).digest("hex").slice(0, 32);
}

function rethrowAfterSubmission(error: unknown, transactionId: string): never {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (!/failed with status| withdrawal .* failed\.?$/i.test(normalized.message)) {
    (normalized as any).withdrawalPending = true;
    (normalized as any).transactionId = transactionId;
  }
  throw normalized;
}

export type UsdtNetwork =
  | "TON"
  | "TRON"
  | "ETHEREUM"
  | "BSC"
  | "POLYGON"
  | "ARBITRUM";

export function getPlatformWallet(): { network: UsdtNetwork; address: string } {
  const requested = (process.env.PLATFORM_USDT_NETWORK || "TRON").toUpperCase();
  if (requested !== "TRON") {
    throw new Error("PLATFORM_USDT_NETWORK must be TRON for the platform wallet.");
  }

  const addressVariable = isTestnet()
    ? "PLATFORM_USDT_TESTNET_WALLET_ADDRESS"
    : "PLATFORM_USDT_WALLET_ADDRESS";
  const address = process.env[addressVariable]?.trim();
  if (!address) {
    throw new Error(`${addressVariable} is required.`);
  }
  if (!isValidTronAddress(address)) {
    throw new Error(
      `${addressVariable} must be a valid TRON Base58Check address.`,
    );
  }

  return { network: "TRON", address };
}

/** Destination dedicated to user-approved cumulative profit-share collection. */
export function getSystemWallet(): { network: UsdtNetwork; address: string } {
  const network = (process.env.SYSTEM_WALLET_NETWORK || "TRON").toUpperCase();
  if (network !== "TRON") {
    throw new Error("SYSTEM_WALLET_NETWORK must be TRON for profit-share withdrawals.");
  }
  const address = process.env.SYSTEM_WALLET_ADDRESS?.trim();
  if (!address) throw new Error("SYSTEM_WALLET_ADDRESS is required.");
  if (!isValidTronAddress(address)) {
    throw new Error("SYSTEM_WALLET_ADDRESS must be a valid TRON Base58Check address.");
  }
  return { network: "TRON", address };
}

const networkCodes: Record<
  UsdtNetwork,
  { binance: string; bybit: string; bitget: string; okx: string }
> = {
  TON: { binance: "TON", bybit: "TON", bitget: "TON", okx: "USDT-TON" },
  TRON: { binance: "TRX", bybit: "TRX", bitget: "trc20", okx: "USDT-TRC20" },
  ETHEREUM: { binance: "ETH", bybit: "ETH", bitget: "ERC20", okx: "USDT-ERC20" },
  BSC: { binance: "BSC", bybit: "BSC", bitget: "BEP20", okx: "USDT-BSC" },
  POLYGON: { binance: "MATIC", bybit: "MATIC", bitget: "POLYGON", okx: "USDT-Polygon" },
  ARBITRUM: { binance: "ARBITRUM", bybit: "ARBI", bitget: "ARBITRUM", okx: "USDT-Arbitrum One" },
};

async function withdrawBinance(
  credentials: RawCredentials,
  amount: string,
  destinationAddress: string,
  network: UsdtNetwork,
  requestId: string,
): Promise<WithdrawalResult> {
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
  const transactionId = String(data.id || "");
  if (!transactionId) throw new Error("Binance did not return a withdrawal ID.");
  let confirmation: { status: number; txId?: string };
  try {
    confirmation = await pollBinanceWithdrawal(credentials, baseUrl, transactionId, requestId);
  } catch (error) {
    rethrowAfterSubmission(error, transactionId);
  }
  return {
    transactionId,
    status: "success",
    ...(confirmation.txId ? { blockchainTransactionId: confirmation.txId } : {}),
    raw: { submission: data, confirmation },
  };
}

async function pollBinanceWithdrawal(
  credentials: RawCredentials,
  baseUrl: string,
  transactionId: string,
  requestId: string,
): Promise<{ status: number; txId?: string }> {
  const { intervalMs, maxAttempts } = pollingConfig();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await wait(intervalMs);
    const timestamp = Date.now();
    const query = new URLSearchParams({
      coin: "USDT",
      withdrawOrderId: requestId,
      timestamp: String(timestamp),
    }).toString();
    const signature = crypto.createHmac("sha256", credentials.apiSecret).update(query).digest("hex");
    const { data } = await http.get(`${baseUrl}/sapi/v1/capital/withdraw/history?${query}&signature=${signature}`, {
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });
    const record = (Array.isArray(data) ? data : []).find(
      (item: any) => String(item.id || "") === transactionId || String(item.withdrawOrderId || "") === requestId,
    );
    if (!record) continue;
    const status = Number(record.status);
    if (status === 6) return { status, ...(record.txId ? { txId: String(record.txId) } : {}) };
    if ([1, 3, 5].includes(status)) {
      throw new Error(`Binance withdrawal ${transactionId} failed with status ${status}.`);
    }
  }
  throw new Error(`Timed out waiting for Binance withdrawal ${transactionId} to complete.`);
}

async function withdrawBybit(
  credentials: RawCredentials,
  amount: string,
  destinationAddress: string,
  network: UsdtNetwork,
  requestId: string,
): Promise<WithdrawalResult> {
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const body = JSON.stringify({
    coin: "USDT",
    chain: networkCodes[network].bybit,
    address: destinationAddress,
    amount,
    timestamp: Number(timestamp),
    forceChain: 1,
    accountType: "UTA",
    requestId,
  });
  const signature = crypto
    .createHmac("sha256", credentials.apiSecret)
    .update(timestamp + credentials.apiKey + recvWindow + body)
    .digest("hex");
  const baseUrl = getExchangeRestUrl("bybit");
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
  const transactionId = String(data.result?.id || "");
  if (!transactionId) throw new Error("Bybit did not return a withdrawal ID.");
  let confirmation: { status: string; txID?: string };
  try {
    confirmation = await pollBybitWithdrawal(credentials, baseUrl, transactionId);
  } catch (error) {
    rethrowAfterSubmission(error, transactionId);
  }
  return {
    transactionId,
    status: "success",
    ...(confirmation.txID ? { blockchainTransactionId: confirmation.txID } : {}),
    raw: { submission: data, confirmation },
  };
}

async function getBybitWithdrawalStatus(
  credentials: RawCredentials,
  baseUrl: string,
  transactionId: string,
): Promise<{ status: string; txID?: string } | null> {
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const query = new URLSearchParams({ withdrawID: transactionId }).toString();
  const signature = crypto
    .createHmac("sha256", credentials.apiSecret)
    .update(timestamp + credentials.apiKey + recvWindow + query)
    .digest("hex");
  const { data } = await http.get(
    `${baseUrl}/v5/asset/withdraw/query-record?${query}`,
    {
      headers: {
        "X-BAPI-API-KEY": credentials.apiKey,
        "X-BAPI-SIGN": signature,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
      },
    },
  );
  if (data.retCode !== 0) {
    throw new Error(data.retMsg || "Unable to query Bybit withdrawal status.");
  }
  const record = data.result?.rows?.[0];
  return record
    ? {
        status: String(record.status),
        ...(record.txID ? { txID: String(record.txID) } : {}),
      }
    : null;
}

async function pollBybitWithdrawal(
  credentials: RawCredentials,
  baseUrl: string,
  transactionId: string,
): Promise<{ status: string; txID?: string }> {
  const { intervalMs, maxAttempts } = pollingConfig();
  const successStatuses = new Set(["success", "blockchainconfirmed"]);
  const failureStatuses = new Set([
    "cancelbyuser",
    "reject",
    "fail",
    "moreinformationrequired",
    "highvaluereviewrejected",
  ]);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await wait(intervalMs);
    const record = await getBybitWithdrawalStatus(
      credentials,
      baseUrl,
      transactionId,
    );
    if (!record) continue;
    const status = record.status.toLowerCase();
    if (successStatuses.has(status)) return record;
    if (failureStatuses.has(status)) {
      throw new Error(
        `Bybit withdrawal ${transactionId} failed with status ${record.status}.`,
      );
    }
  }

  throw new Error(
    `Timed out waiting for Bybit withdrawal ${transactionId} to complete.`,
  );
}

async function withdrawBitget(
  credentials: RawCredentials,
  amount: string,
  destinationAddress: string,
  network: UsdtNetwork,
  requestId: string,
): Promise<WithdrawalResult> {
  const { apiKey, apiSecret, passphrase } = credentials;
  if (!passphrase) throw new Error("Bitget requires a passphrase.");

  const timestamp = Date.now().toString();
  const method = "POST";
  const path = "/api/v3/account/withdrawal";
  const body = JSON.stringify({
    coin: "USDT",
    transferType: "on_chain",
    address: destinationAddress,
    chain: networkCodes[network].bitget,
    size: amount,
    clientOid: requestId,
    accountType: "uta",
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
      orderId: string;
      clientOid?: string;
    } | null;
  }

  const { data } = await http.post<BitgetWithdrawResponse>(
    getBitgetBaseUrl() + path,
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

  const transactionId = data.data?.orderId;
  if (!transactionId) throw new Error("Bitget did not return a withdrawal ID.");
  let confirmation: BitgetWithdrawalRecord;
  try {
    confirmation = await pollBitgetWithdrawal(credentials, transactionId, Date.now());
  } catch (error) {
    rethrowAfterSubmission(error, transactionId);
  }
  return {
    transactionId,
    status: "success",
    ...(confirmation.recordId
      ? { blockchainTransactionId: confirmation.recordId }
      : {}),
    raw: { submission: data, confirmation },
  };
}

interface BitgetWithdrawalRecord {
  orderId: string;
  status: string;
  recordId?: string;
}

async function getBitgetWithdrawalStatus(
  credentials: RawCredentials,
  transactionId: string,
  submittedAt: number,
): Promise<BitgetWithdrawalRecord | null> {
  const { apiKey, apiSecret, passphrase } = credentials;
  if (!passphrase) throw new Error("Bitget requires a passphrase.");
  const timestamp = Date.now().toString();
  const method = "GET";
  const path = "/api/v3/account/withdrawal-records";
  const query = new URLSearchParams({
    orderId: transactionId,
    startTime: String(submittedAt - 60_000),
    endTime: String(Date.now() + 1_000),
  }).toString();
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(timestamp + method + path + "?" + query)
    .digest("base64");
  const { data } = await http.get(`${getBitgetBaseUrl()}${path}?${query}`, {
    headers: {
      ...(isBitgetDemo() ? { paptrading: "1" } : {}),
      "ACCESS-KEY": apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": passphrase,
      "Content-Type": "application/json",
    },
  });
  if (data.code !== "00000") {
    throw new Error(data.msg || "Unable to query Bitget withdrawal status.");
  }
  const record = data.data?.[0];
  return record
    ? {
        orderId: String(record.orderId),
        status: String(record.status),
        ...(record.recordId ? { recordId: String(record.recordId) } : {}),
      }
    : null;
}

async function pollBitgetWithdrawal(
  credentials: RawCredentials,
  transactionId: string,
  submittedAt: number,
): Promise<BitgetWithdrawalRecord> {
  const { intervalMs, maxAttempts } = pollingConfig();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await wait(intervalMs);
    const record = await getBitgetWithdrawalStatus(
      credentials,
      transactionId,
      submittedAt,
    );
    if (!record) continue;
    const status = record.status.toLowerCase();
    if (status === "success") return record;
    if (status === "fail") {
      throw new Error(`Bitget withdrawal ${transactionId} failed.`);
    }
  }

  throw new Error(
    `Timed out waiting for Bitget withdrawal ${transactionId} to complete.`,
  );
}

async function withdrawOkx(
  credentials: RawCredentials,
  amount: string,
  destinationAddress: string,
  network: UsdtNetwork,
  requestId: string,
): Promise<WithdrawalResult> {
  const { apiKey, apiSecret, passphrase } = credentials;
  if (!passphrase) throw new Error("OKX requires a passphrase.");

  const timestamp = new Date().toISOString();
  const method = "POST";
  const path = "/api/v5/asset/withdrawal";
  const fee = process.env.OKX_USDT_TRON_WITHDRAWAL_FEE?.trim();
  if (!fee || !/^\d+(\.\d+)?$/.test(fee) || Number(fee) < 0) {
    throw new Error("OKX_USDT_TRON_WITHDRAWAL_FEE must be configured before OKX withdrawals.");
  }
  const body = JSON.stringify({
    ccy: "USDT",
    amt: amount,
    dest: "4", // digital wallet address
    toAddr: destinationAddress,
    chain: networkCodes[network].okx,
    clientId: requestId,
    fee,
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
  if (wdId === "unknown") throw new Error("OKX did not return a withdrawal ID.");
  let confirmation: { state: string; txId?: string };
  try {
    confirmation = await pollOkxWithdrawal(credentials, wdId);
  } catch (error) {
    rethrowAfterSubmission(error, wdId);
  }
  return {
    transactionId: wdId,
    status: "success",
    ...(confirmation.txId ? { blockchainTransactionId: confirmation.txId } : {}),
    raw: { submission: data, confirmation },
  };
}

async function pollOkxWithdrawal(
  credentials: RawCredentials,
  withdrawalId: string,
): Promise<{ state: string; txId?: string }> {
  const { apiKey, apiSecret, passphrase } = credentials;
  if (!passphrase) throw new Error("OKX requires a passphrase.");
  const { intervalMs, maxAttempts } = pollingConfig();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await wait(intervalMs);
    const timestamp = new Date().toISOString();
    const query = new URLSearchParams({ wdId: withdrawalId }).toString();
    const path = `/api/v5/asset/withdrawal-history?${query}`;
    const signature = crypto.createHmac("sha256", apiSecret)
      .update(timestamp + "GET" + path).digest("base64");
    const { data } = await http.get(`https://www.okx.com${path}`, {
      headers: {
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": passphrase,
        ...(isOkxDemo() ? { "x-simulated-trading": "1" } : {}),
      },
    });
    if (data.code !== "0") throw new Error(data.msg || "Unable to query OKX withdrawal status.");
    const record = data.data?.[0];
    if (!record) continue;
    const state = String(record.state);
    if (state === "2") return { state, ...(record.txId ? { txId: String(record.txId) } : {}) };
    if (["-1", "-2", "-3"].includes(state)) {
      throw new Error(`OKX withdrawal ${withdrawalId} failed with status ${state}.`);
    }
  }
  throw new Error(`Timed out waiting for OKX withdrawal ${withdrawalId} to complete.`);
}

// ─── Public Withdrawal API ────────────────────────────────────────────────────

export async function withdrawUsdt(
  exchange: ExchangeId,
  credentials: RawCredentials,
  amount: string,
  destinationAddress: string,
  network: UsdtNetwork = "TRON",
  requestId: string = crypto.randomUUID().replaceAll("-", "").slice(0, 32),
): Promise<WithdrawalResult> {
  try {
    const normalizedAmount = String(amount).trim();
    if (
      !/^\d+(\.\d{1,6})?$/.test(normalizedAmount) ||
      !Number.isFinite(Number(normalizedAmount)) ||
      Number(normalizedAmount) <= 0
    ) {
      throw new Error(
        "USDT withdrawal amount must be positive with at most 6 decimal places.",
      );
    }
    if (network !== "TRON") {
      throw new Error("Platform USDT withdrawals must use the TRON network.");
    }
    if (!isValidTronAddress(destinationAddress)) {
      throw new Error(
        "Withdrawal destination must be a valid TRON Base58Check address.",
      );
    }
    if (process.env.PROFIT_WITHDRAWAL_MODE !== "live") {
      return {
        transactionId: `dry-run-${requestId}`,
        status: "dry-run",
        raw: { mode: "dry-run", exchange, amount, destinationAddress, network },
      };
    }
    if (exchange === "bitget" && isTestnet()) {
      throw new Error(
        "Bitget does not provide an on-chain testnet withdrawal environment.",
      );
    }
    const exchangeRequestId = normalizeRequestId(requestId);
    if (exchange === "binance") {
      return await withdrawBinance(credentials, amount, destinationAddress, network, exchangeRequestId);
    } else if (exchange === "bybit") {
      return await withdrawBybit(credentials, amount, destinationAddress, network, exchangeRequestId);
    }
    if (exchange === "okx") {
      return await withdrawOkx(credentials, amount, destinationAddress, network, exchangeRequestId);
    } else if (exchange === "bitget") {
      return await withdrawBitget(credentials, amount, destinationAddress, network, exchangeRequestId);
    } else {
      throw new Error(`Withdrawal is not supported for ${exchange}.`);
    }
  } catch (err) {
    const error = normalizeError(err);
    (error as any).exchange = exchange;
    throw error;
  }
}
