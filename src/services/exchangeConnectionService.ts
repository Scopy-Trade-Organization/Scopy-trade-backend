import crypto from "crypto";
import axios from "axios";
import {
  RawCredentials,
  ExchangeId,
  EncryptedCredentials,
  AccountInfo,
  BybitAccountInfo,
  OkxAccountInfo,
  BitgetAccountInfo,
} from "../types/index.js";
import axiosRetry from "axios-retry";
import { getExchangeMode, getExchangeRestUrl, isBitgetDemo, isOkxDemo } from "./exchangeEnvironment.js";


export const http = axios.create({
  timeout: 8000,
});

axiosRetry(http, {
  retries: 2,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) =>
    (error.config?.method?.toLowerCase() === "get") && (axiosRetry.isNetworkError(error) || (error.response?.status ?? 0) >= 500),
});

export class CredentialValidationError extends Error {}

export function credentialValidationMessage(err: unknown): string {
  return err instanceof CredentialValidationError
    ? err.message
    : "The exchange rejected the credentials or is temporarily unavailable.";
}

function bitgetValidationError(rawCode: unknown): CredentialValidationError {
  const code = typeof rawCode === "string" && /^\d{5}$/.test(rawCode) ? rawCode : undefined;
  const mode = getExchangeMode();
  const messages: Record<string, string> = {
    "40005": "Bitget rejected the request timestamp. Check the backend server clock.",
    "40008": "Bitget reports an expired timestamp. Synchronize the backend server clock.",
    "40009": "Bitget rejected the request signature. Check that the API secret belongs to this API key.",
    "40012": "Bitget rejected the API key or API passphrase.",
    "40014": "Bitget API permissions are insufficient. Enable UTA management and UTA trading Read/Write permissions.",
    "40018": "Bitget rejected the server IP. Add the backend server's outbound IP to the API key whitelist.",
    "40036": "Bitget rejected the API passphrase. Use the passphrase created with the API key.",
    "40038": "The backend server's outbound IP is not in the Bitget API key whitelist.",
    "40040": "Bitget API key permissions are invalid. Check the API key permission settings.",
    "40085": "Bitget rejected an account API request because the account mode does not match the endpoint. This integration requires Unified Trading Account (UTA) mode.",
  };
  const keyMessage = `Bitget could not find a valid API key for ${mode === "testnet" ? "demo" : "live"} mode. Use a matching ${mode === "testnet" ? "Demo API Key" : "live API key"} and check EXCHANGE_MODE on the backend.`;
  const message = code && ["40006", "40037", "40041"].includes(code)
    ? keyMessage
    : (code && messages[code]) || "Bitget rejected the connection request. Check the API key mode, permissions and server IP whitelist.";
  return new CredentialValidationError(`${message}${code ? ` (Bitget code ${code})` : ""}`);
}

function normalizeError(err: unknown, exchange?: ExchangeId): Error {
  if (axios.isAxiosError(err)) {
    if (exchange === "bitget") {
      const rawCode = err.response?.data?.code;
      // Never log the Axios error, headers, request config or remote message.
      const code = typeof rawCode === "string" && /^\d{5}$/.test(rawCode) ? rawCode : undefined;
      console.error("Exchange credential validation failed", { exchange, status: err.response?.status, code, mode: getExchangeMode() });
      return err.response ? bitgetValidationError(code) : new CredentialValidationError("Bitget could not be reached. Try again shortly.");
    }
    console.error("Exchange credential validation failed", { status: err.response?.status });
    return new Error("The exchange rejected the credentials or is temporarily unavailable.");
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

    const hasTradePermission = info.readOnly === 0 && (info.permissions?.Derivatives?.includes("DerivativesTrade") || (info.permissions?.ContractTrade?.includes("Order") && info.permissions?.ContractTrade?.includes("Position")));

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
      data: Array<{ acctLv: string; posMode: string; uid: string; perm: string }>;
    }

    const { data } = await http.get<OkxResponse>(getExchangeRestUrl("okx") + path, {
      headers: {
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": passphrase,
        ...(isOkxDemo() ? { "x-simulated-trading": "1" } : {}),
      },
      timeout: 8000,
    });
    if (data.code !== "0")
      throw new Error(data.msg || "Invalid OKX API credentials.");

    const config = data.data[0];
    if (!config)
      throw new Error("OKX returned an empty configuration response.");
    if (!config.perm?.split(",").includes("trade")) throw new Error("OKX API key needs Trade permission.");
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
      throw new CredentialValidationError("Bitget requires a passphrase. Please provide it.");
    async function read(path: string) {
      const timestamp = String(Date.now());
      const { data } = await http.get(getExchangeRestUrl("bitget") + path, {
        headers: {
          ...(isBitgetDemo() ? { paptrading: "1" } : {}),
          "ACCESS-KEY": apiKey,
          "ACCESS-SIGN": crypto.createHmac("sha256", apiSecret).update(timestamp + "GET" + path).digest("base64"),
          "ACCESS-TIMESTAMP": timestamp,
          "ACCESS-PASSPHRASE": passphrase,
          "Content-Type": "application/json",
        },
      });
      if (data.code !== "00000") throw bitgetValidationError(data.code);
      return data.data;
    }
    const info = await read("/api/v3/account/info");
    if (!info?.userId) throw new CredentialValidationError("Bitget returned incomplete UTA account information.");
    if (!["read_and_write", "read-and-write"].includes(info.permType) ||
        !Array.isArray(info.permissions) || !["uta_mgt", "uta_trade"].every(p => info.permissions.includes(p))) {
      throw new CredentialValidationError("Bitget API key requires UTA management and UTA trading Read/Write permissions.");
    }
    const settings = await read("/api/v3/account/settings");
    if (!["unified", "hybrid"].includes(settings?.accountMode)) {
      throw new CredentialValidationError("Enable Unified Trading Account (UTA) mode in Bitget before connecting this account.");
    }
    const assets = await read("/api/v3/account/assets");
    if (!Array.isArray(assets?.assets)) throw new CredentialValidationError("Bitget did not return valid UTA balances.");
    return {
      userId: String(info.userId), inviterId: String(info.inviterId || ""), ips: info.ips || "",
      authorities: info.permissions, parentId: String(info.parentId || ""), trader: info.traderType === "trader",
      accountMode: settings.accountMode, accountLevel: settings.accountLevel, apiVersion: "v3",
    };
  } catch (error) {
    throw normalizeError(error, "bitget");
  }
};

// ─── Validator Registry ───────────────────────────────────────────────────────

const validators: Record<ExchangeId, Validator<AccountInfo>> = {
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
