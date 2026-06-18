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

export function normalizeError(err: unknown): Error {
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

export async function getBybitTimestamp(baseUrl: string): Promise<string> {
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
        "x-simulated-trading": "0",
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
    // Hit the USDT-M futures account endpoint directly — if this succeeds,
    // the key has futures permissions
    const path = "/api/v2/mix/account/accounts?productType=USDT-FUTURES";
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

    const { data } = await http.get<BitgetFuturesAccountResponse>(
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
      throw new Error(
        data.msg ||
          "Invalid Bitget API credentials or missing Futures trading permissions. " +
            "Enable Futures trading in Bitget API settings.",
      );

    if (!data.data || data.data.length === 0)
      throw new Error(
        "Bitget futures account returned no data. Ensure Futures trading is enabled.",
      );

    return {
      userId: "",
      inviterId: "",
      ips: "",
      authorities: ["FUTURES"],
      parentId: "",
      trader: false,
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
        "x-simulated-trading": "0",
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

  const { data } = await http.get<BitgetFuturesBalanceResponse>(
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
