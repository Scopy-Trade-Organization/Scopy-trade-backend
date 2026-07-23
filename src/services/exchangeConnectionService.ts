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
import { getExchangeRestUrl } from "./exchangeEnvironment.js";

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
    const baseUrl = getExchangeRestUrl("binance");
    const { data: timeData } = await http.get(`${baseUrl}/fapi/v1/time`);
    const timestamp = timeData.serverTime;
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(queryString)
      .digest("hex");

    const { data } = await http.get<BinanceAccountInfo & { canTrade: boolean }>(
      `${baseUrl}/fapi/v2/account`,
      {
        params: { timestamp, signature },
        headers: { "X-MBX-APIKEY": apiKey },
        timeout: 8000,
      },
    );
    if (!data.canTrade)
      throw new Error("API key does not have trading permissions enabled.");
    return {
      accountType: "USD-M_FUTURES",
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
    const baseUrl = getExchangeRestUrl("bybit");
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
      info.permissions?.Derivatives?.includes("DerivativesTrade") ?? false;

    if (!hasTradePermission)
      throw new Error(
        "API key does not have derivatives trading permission in Bybit API settings.",
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
    const path = "/api/v2/spot/account/info";
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

    const { data } = await http.get<BitgetResponse>(BITGET_BASE_URL + path, {
      headers: {
        ...(process.env.BITGET_DEMO_MODE === "true" ? { paptrading: "1" } : {}),
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
        : true;

    if (!hasTradePermission)
      throw new Error(
        "API key does not have trading permissions. Enable Spot or Futures trading in Bitget API settings.",
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

export { normalizeError, getBybitTimestamp };
