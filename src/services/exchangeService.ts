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
  KucoinAccountInfo,
} from "../types/index.js";

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
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Stored as "iv:authTag:ciphertext" (all hex)
  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

function decrypt(stored: string): string {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, encryptedHex] = stored.split(":");

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

// ── Binance ───────────────────────────────────────────────────────────────────
// Docs: https://binance-docs.github.io/apidocs/spot/en/#account-information-user_data
const validateBinance: Validator<BinanceAccountInfo> = async ({
  apiKey,
  apiSecret,
}) => {
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(queryString)
    .digest("hex");

  const { data } = await axios.get<BinanceAccountInfo & { canTrade: boolean }>(
    "https://api.binance.com/api/v3/account",
    {
      params: { timestamp, signature },
      headers: { "X-MBX-APIKEY": apiKey },
      timeout: 8000,
    },
  );

  if (!data.canTrade) {
    throw new Error(
      "API key does not have trading permissions enabled. Enable Spot Trading in your Binance API settings.",
    );
  }

  return {
    accountType: data.accountType,
    canTrade: data.canTrade,
    canWithdraw: data.canWithdraw,
    permissions: data.permissions,
  };
};

// ── Bybit ─────────────────────────────────────────────────────────────────────
// Docs: https://bybit-exchange.github.io/docs/v5/user/apikey-info
const validateBybit: Validator<BybitAccountInfo> = async ({
  apiKey,
  apiSecret,
}) => {
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

  const { data } = await axios.get<BybitResponse>(
    "https://api.bybit.com/v5/user/query-api",
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

  if (data.retCode !== 0) {
    throw new Error(data.retMsg || "Invalid Bybit API credentials.");
  }

  const info = data.result;
  const hasTradePermission =
    (info.permissions?.ContractTrade?.length ?? 0) > 0 ||
    (info.permissions?.SpotTrade?.length ?? 0) > 0;

  if (!hasTradePermission) {
    throw new Error(
      "API key does not have trading permissions. Enable Spot or Derivatives trading in Bybit API settings.",
    );
  }

  return {
    accountType: info.accountType,
    permissions: info.permissions,
    readOnly: info.readOnly === 1,
  };
};

// ── OKX ───────────────────────────────────────────────────────────────────────
// Docs: https://www.okx.com/docs-v5/en/#trading-account-rest-api-get-account-configuration
// OKX requires a passphrase + uses base64 HMAC (not hex)
const validateOkx: Validator<OkxAccountInfo> = async ({
  apiKey,
  apiSecret,
  passphrase,
}) => {
  if (!passphrase) {
    throw new Error("OKX requires a passphrase. Please provide it.");
  }

  const timestamp = new Date().toISOString();
  const method = "GET";
  const path = "/api/v5/account/config";
  const signPayload = timestamp + method + path;

  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("base64"); // OKX uses base64, not hex

  interface OkxResponse {
    code: string;
    msg: string;
    data: Array<{ acctLv: string; posMode: string; uid: string }>;
  }

  const { data } = await axios.get<OkxResponse>("https://www.okx.com" + path, {
    headers: {
      "OK-ACCESS-KEY": apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": passphrase,
      "x-simulated-trading": "0", // 0 = live, 1 = paper trading
    },
    timeout: 8000,
  });

  if (data.code !== "0") {
    throw new Error(data.msg || "Invalid OKX API credentials.");
  }

  const config = data.data[0];
  return {
    accountLevel: config.acctLv,
    posMode: config.posMode,
    uid: config.uid,
  };
};

// ── KuCoin ────────────────────────────────────────────────────────────────────
// Docs: https://docs.kucoin.com
// KuCoin requires passphrase + the passphrase itself must be HMAC-signed (v2)
const validateKucoin: Validator<KucoinAccountInfo> = async ({
  apiKey,
  apiSecret,
  passphrase,
}) => {
  if (!passphrase) {
    throw new Error("KuCoin requires a passphrase. Please provide it.");
  }

  const timestamp = Date.now().toString();
  const method = "GET";
  const endpoint = "/api/v1/accounts";
  const signPayload = timestamp + method + endpoint;

  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("base64");

  // KuCoin v2: the passphrase itself must also be signed
  const signedPassphrase = crypto
    .createHmac("sha256", apiSecret)
    .update(passphrase)
    .digest("base64");

  interface KucoinAccount {
    currency: string;
    balance: string;
    type: string;
  }
  interface KucoinResponse {
    code: string;
    msg?: string;
    data: KucoinAccount[];
  }

  const { data } = await axios.get<KucoinResponse>(
    "https://api.kucoin.com" + endpoint,
    {
      headers: {
        "KC-API-KEY": apiKey,
        "KC-API-SIGN": signature,
        "KC-API-TIMESTAMP": timestamp,
        "KC-API-PASSPHRASE": signedPassphrase,
        "KC-API-KEY-VERSION": "2",
      },
      timeout: 8000,
    },
  );

  if (data.code !== "200000") {
    throw new Error(data.msg || "Invalid KuCoin API credentials.");
  }

  const tradingAccounts = data.data.filter((a) => a.type === "trade");
  if (tradingAccounts.length === 0) {
    throw new Error(
      "No trading account found. Ensure your KuCoin API key has trade permissions.",
    );
  }

  return {
    accounts: tradingAccounts.map((a) => ({
      currency: a.currency,
      balance: a.balance,
      type: a.type,
    })),
  };
};

// ─── Validator Registry ───────────────────────────────────────────────────────

const validators: Record<ExchangeId, Validator<AccountInfo>> = {
  binance: validateBinance,
  bybit: validateBybit,
  okx: validateOkx,
  kucoin: validateKucoin,
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validates credentials against the exchange and returns sanitized account info.
 * Throws a descriptive error if validation fails.
 */
export async function validateCredentials(
  exchange: ExchangeId,
  credentials: RawCredentials,
): Promise<AccountInfo> {
  const validator = validators[exchange];
  return validator(credentials);
}

/**
 * Encrypts credentials for safe storage.
 * Returns an object ready to be saved to the database.
 */
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

/**
 * Decrypts stored credentials back to plaintext for use in trade execution.
 */
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
