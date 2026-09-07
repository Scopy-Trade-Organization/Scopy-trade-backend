import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { http } from "./exchangeConnectionService.js";
import { getPlatformWallet, withdrawUsdt } from "./withdrawalService.js";
import type { RawCredentials } from "../types/index.js";

const CREDS: RawCredentials = {
  apiKey: "key",
  apiSecret: "secret",
  passphrase: "pass",
};
const VALID_TRON_ADDRESS = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";

// These env vars are read at call time inside withdrawUsdt / the demo helpers,
// so we can flip them per test and restore afterwards.
const ENV_KEYS = [
  "PROFIT_WITHDRAWAL_MODE",
  "BITGET_DEMO_MODE",
  "OKX_DEMO_MODE",
  "PLATFORM_USDT_NETWORK",
  "PLATFORM_USDT_WALLET_ADDRESS",
  "PLATFORM_USDT_TESTNET_WALLET_ADDRESS",
  "EXCHANGE_MODE",
  "BYBIT_TEST_API_URL",
  "BYBIT_API_URL",
  "WITHDRAWAL_STATUS_POLL_INTERVAL_MS",
  "WITHDRAWAL_STATUS_POLL_MAX_ATTEMPTS",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

afterEach(() => {
  mock.restoreAll();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

type Captured = { url: string; body: unknown; config: any };

// Replace the shared axios instance's post() so no real network call is made,
// and capture what each withdrawal helper sent.
function mockPost(returnData: unknown): Captured[] {
  const calls: Captured[] = [];
  mock.method(http as any, "post", async (url: string, body: unknown, config: any) => {
    calls.push({ url, body, config });
    return { data: returnData };
  });
  return calls;
}

function mockGet(...returnData: unknown[]): Captured[] {
  const calls: Captured[] = [];
  let index = 0;
  mock.method(http as any, "get", async (url: string, config: any) => {
    calls.push({ url, body: null, config });
    const data = returnData[Math.min(index, returnData.length - 1)];
    index += 1;
    return { data };
  });
  return calls;
}

function useImmediatePolling(maxAttempts = 3): void {
  process.env.WITHDRAWAL_STATUS_POLL_INTERVAL_MS = "0";
  process.env.WITHDRAWAL_STATUS_POLL_MAX_ATTEMPTS = String(maxAttempts);
}

test("returns a dry-run id and skips the network when not in live mode", async () => {
  delete process.env.PROFIT_WITHDRAWAL_MODE;
  const calls = mockPost({ code: "00000", data: { withdrawId: "X" } });
  const res = await withdrawUsdt(
    "bitget",
    CREDS,
    "10",
    VALID_TRON_ADDRESS,
    "TRON",
    "req-1",
  );
  assert.equal(res.transactionId, "dry-run-req-1");
  assert.equal(calls.length, 0);
});

test("bitget live withdrawal sends the paptrading header in demo mode and disables retries", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  process.env.EXCHANGE_MODE = "live";
  process.env.BITGET_DEMO_MODE = "true";
  useImmediatePolling();
  const calls = mockPost({ code: "00000", data: { orderId: "WID123" } });
  const statusCalls = mockGet({
    code: "00000",
    data: [{ orderId: "WID123", status: "success", recordId: "TX123" }],
  });
  const res = await withdrawUsdt(
    "bitget",
    CREDS,
    "10",
    VALID_TRON_ADDRESS,
    "TRON",
    "req-2",
  );
  assert.equal(res.transactionId, "WID123");
  assert.equal(res.status, "success");
  assert.equal(res.blockchainTransactionId, "TX123");
  assert.equal(calls.length, 1);
  assert.equal(statusCalls.length, 1);
  const body = JSON.parse(calls[0]!.body as string);
  assert.equal(body.accountType, "uta");
  assert.equal(body.chain, "trc20");
  const { config } = calls[0]!;
  assert.equal(config.headers.paptrading, "1");
  assert.equal(config["axios-retry"].retries, 0);
});

test("bitget live withdrawal omits the paptrading header when demo mode is off", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  process.env.EXCHANGE_MODE = "live";
  process.env.BITGET_DEMO_MODE = "false";
  useImmediatePolling();
  const calls = mockPost({ code: "00000", data: { orderId: "WID" } });
  mockGet({ code: "00000", data: [{ orderId: "WID", status: "success" }] });
  await withdrawUsdt("bitget", CREDS, "10", VALID_TRON_ADDRESS, "TRON", "req-3");
  assert.equal(calls[0]!.config.headers.paptrading, undefined);
});

test("okx live withdrawal defaults to the simulated-trading header", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  delete process.env.OKX_DEMO_MODE;
  const calls = mockPost({ code: "0", data: [{ wdId: "WD1" }] });
  const res = await withdrawUsdt("okx", CREDS, "10", VALID_TRON_ADDRESS, "TRON", "req-4");
  assert.equal(res.transactionId, "WD1");
  assert.equal(calls[0]!.config.headers["x-simulated-trading"], "1");
  assert.equal(calls[0]!.config["axios-retry"].retries, 0);
});

test("okx live withdrawal omits the simulated-trading header when explicitly disabled", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  process.env.OKX_DEMO_MODE = "false";
  const calls = mockPost({ code: "0", data: [{ wdId: "WD2" }] });
  await withdrawUsdt("okx", CREDS, "10", VALID_TRON_ADDRESS, "TRON", "req-5");
  assert.equal(calls[0]!.config.headers["x-simulated-trading"], undefined);
});

test("binance live withdrawal posts to the withdraw endpoint with retries disabled", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  const calls = mockPost({ id: "BID99" });
  const res = await withdrawUsdt("binance", CREDS, "25", VALID_TRON_ADDRESS, "TRON", "req-6");
  assert.equal(res.transactionId, "BID99");
  assert.ok(calls[0]!.url.includes("/sapi/v1/capital/withdraw/apply"));
  assert.equal(calls[0]!.config["axios-retry"].retries, 0);
});

test("bybit withdraws from UTA over TRON and waits for confirmation", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  process.env.EXCHANGE_MODE = "testnet";
  process.env.BYBIT_TEST_API_URL = "https://api-testnet.example";
  useImmediatePolling();
  const calls = mockPost({ retCode: 0, retMsg: "success", result: { id: "BY1" } });
  const statusCalls = mockGet(
    { retCode: 0, result: { rows: [{ status: "Pending", withdrawId: "BY1" }] } },
    {
      retCode: 0,
      result: { rows: [{ status: "success", withdrawId: "BY1", txID: "TRONTX" }] },
    },
  );
  const result = await withdrawUsdt(
    "bybit",
    CREDS,
    "5",
    VALID_TRON_ADDRESS,
    "TRON",
    "reqtron1",
  );
  const body = JSON.parse(calls[0]!.body as string);
  assert.equal(body.chain, "TRX");
  assert.equal(body.accountType, "UTA");
  assert.ok(calls[0]!.url.startsWith("https://api-testnet.example/"));
  assert.ok(statusCalls[0]!.url.startsWith("https://api-testnet.example/"));
  assert.equal(statusCalls.length, 2);
  assert.equal(result.status, "success");
  assert.equal(result.blockchainTransactionId, "TRONTX");
});

test("normalizes long post-trade request IDs for exchange idempotency", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  process.env.EXCHANGE_MODE = "testnet";
  useImmediatePolling();
  const calls = mockPost({ retCode: 0, retMsg: "success", result: { id: "ID1" } });
  mockGet({ retCode: 0, result: { rows: [{ status: "success" }] } });
  await withdrawUsdt(
    "bybit",
    CREDS,
    "5",
    VALID_TRON_ADDRESS,
    "TRON",
    "copy-profit-507f1f77bcf86cd799439011",
  );
  const sentRequestId = JSON.parse(calls[0]!.body as string).requestId as string;
  assert.match(sentRequestId, /^[A-Za-z0-9]{32}$/);
});

test("reads and validates the platform TRON wallet from environment configuration", () => {
  process.env.EXCHANGE_MODE = "live";
  process.env.PLATFORM_USDT_NETWORK = "tron";
  process.env.PLATFORM_USDT_WALLET_ADDRESS = `  ${VALID_TRON_ADDRESS}  `;
  assert.deepEqual(getPlatformWallet(), {
    network: "TRON",
    address: VALID_TRON_ADDRESS,
  });
});

test("uses a separate TRON recipient address in testnet mode", () => {
  process.env.EXCHANGE_MODE = "testnet";
  process.env.PLATFORM_USDT_NETWORK = "TRON";
  process.env.PLATFORM_USDT_WALLET_ADDRESS = "not-used-on-testnet";
  process.env.PLATFORM_USDT_TESTNET_WALLET_ADDRESS = VALID_TRON_ADDRESS;
  assert.deepEqual(getPlatformWallet(), {
    network: "TRON",
    address: VALID_TRON_ADDRESS,
  });
});

test("blocks Bitget on-chain withdrawals while the app is in testnet mode", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  process.env.EXCHANGE_MODE = "testnet";
  await assert.rejects(
    () =>
      withdrawUsdt(
        "bitget",
        CREDS,
        "10",
        VALID_TRON_ADDRESS,
        "TRON",
        "reqtestnet1",
      ),
    /does not provide an on-chain testnet withdrawal environment/,
  );
});

test("rejects TON configuration and malformed TRON addresses", () => {
  process.env.EXCHANGE_MODE = "live";
  process.env.PLATFORM_USDT_NETWORK = "TON";
  process.env.PLATFORM_USDT_WALLET_ADDRESS = VALID_TRON_ADDRESS;
  assert.throws(() => getPlatformWallet(), /must be TRON/);

  process.env.PLATFORM_USDT_NETWORK = "TRON";
  process.env.PLATFORM_USDT_WALLET_ADDRESS = "T-not-valid";
  assert.throws(() => getPlatformWallet(), /valid TRON Base58Check/);
});

test("rejects missing platform wallet configuration", () => {
  process.env.EXCHANGE_MODE = "live";
  delete process.env.PLATFORM_USDT_WALLET_ADDRESS;
  assert.throws(() => getPlatformWallet(), /PLATFORM_USDT_WALLET_ADDRESS is required/);
});

test("throws and tags the exchange when the API returns a failure code", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  process.env.EXCHANGE_MODE = "live";
  mockPost({ code: "40001", msg: "bad request", data: null });
  await assert.rejects(
    () => withdrawUsdt("bitget", CREDS, "10", VALID_TRON_ADDRESS, "TRON", "req-7"),
    (err: any) => {
      assert.equal(err.exchange, "bitget");
      assert.match(err.message, /bad request/);
      return true;
    },
  );
});

test("normalizes and tags thrown transport errors", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  mock.method(http as any, "post", async () => {
    throw new Error("network down");
  });
  await assert.rejects(
    () => withdrawUsdt("okx", CREDS, "10", VALID_TRON_ADDRESS, "TRON", "req-8"),
    (err: any) => {
      assert.equal(err.exchange, "okx");
      assert.match(err.message, /network down/);
      return true;
    },
  );
});

test("does not report success when Bitget returns a failed terminal status", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  process.env.EXCHANGE_MODE = "live";
  useImmediatePolling();
  mockPost({ code: "00000", data: { orderId: "FAILED1" } });
  mockGet({
    code: "00000",
    data: [{ orderId: "FAILED1", status: "fail" }],
  });
  await assert.rejects(
    () =>
      withdrawUsdt(
        "bitget",
        CREDS,
        "10",
        VALID_TRON_ADDRESS,
        "TRON",
        "reqfail1",
      ),
    /Bitget withdrawal FAILED1 failed/,
  );
});

test("times out instead of treating a pending Bybit withdrawal as successful", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  useImmediatePolling(2);
  mockPost({ retCode: 0, result: { id: "PENDING1" } });
  mockGet({
    retCode: 0,
    result: { rows: [{ status: "Pending", withdrawId: "PENDING1" }] },
  });
  await assert.rejects(
    () =>
      withdrawUsdt(
        "bybit",
        CREDS,
        "10",
        VALID_TRON_ADDRESS,
        "TRON",
        "reqpending1",
      ),
    /Timed out waiting for Bybit withdrawal PENDING1/,
  );
});
