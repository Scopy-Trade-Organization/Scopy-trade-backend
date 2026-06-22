import crypto from "crypto";
import { RawCredentials, ExchangeId } from "../types/index.js";
import { http, normalizeError } from "./exchangeConnectionService.js";

const BITGET_BASE_URL = process.env.BITGET_BASE_URL || "https://api.bitget.com";

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
        ...(process.env.BITGET_DEMO_MODE === "true" ? { paptrading: "1" } : {}),
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

// ─── Public Withdrawal API ────────────────────────────────────────────────────

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
