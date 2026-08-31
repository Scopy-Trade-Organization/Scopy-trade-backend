import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { http } from "./exchangeConnectionService.js";
import { withdrawUsdt } from "./withdrawalService.js";
import type { RawCredentials } from "../types/index.js";

const CREDS: RawCredentials = {
  apiKey: "key",
  apiSecret: "secret",
  passphrase: "pass",
};

// These env vars are read at call time inside withdrawUsdt / the demo helpers,
// so we can flip them per test and restore afterwards.
const ENV_KEYS = [
  "PROFIT_WITHDRAWAL_MODE",
  "BITGET_DEMO_MODE",
  "OKX_DEMO_MODE",
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

test("returns a dry-run id and skips the network when not in live mode", async () => {
  delete process.env.PROFIT_WITHDRAWAL_MODE;
  const calls = mockPost({ code: "00000", data: { withdrawId: "X" } });
  const res = await withdrawUsdt(
    "bitget",
    CREDS,
    "10",
    "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE",
    "TRON",
    "req-1",
  );
  assert.equal(res.transactionId, "dry-run-req-1");
  assert.equal(calls.length, 0);
});

test("bitget live withdrawal sends the paptrading header in demo mode and disables retries", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  process.env.BITGET_DEMO_MODE = "true";
  const calls = mockPost({ code: "00000", data: { withdrawId: "WID123" } });
  const res = await withdrawUsdt("bitget", CREDS, "10", "TAddr", "TRON", "req-2");
  assert.equal(res.transactionId, "WID123");
  assert.equal(calls.length, 1);
  const { config } = calls[0]!;
  assert.equal(config.headers.paptrading, "1");
  assert.equal(config["axios-retry"].retries, 0);
});

test("bitget live withdrawal omits the paptrading header when demo mode is off", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  process.env.BITGET_DEMO_MODE = "false";
  const calls = mockPost({ code: "00000", data: { withdrawId: "WID" } });
  await withdrawUsdt("bitget", CREDS, "10", "TAddr", "TRON", "req-3");
  assert.equal(calls[0]!.config.headers.paptrading, undefined);
});

test("okx live withdrawal defaults to the simulated-trading header", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  delete process.env.OKX_DEMO_MODE;
  const calls = mockPost({ code: "0", data: [{ wdId: "WD1" }] });
  const res = await withdrawUsdt("okx", CREDS, "10", "TAddr", "TRON", "req-4");
  assert.equal(res.transactionId, "WD1");
  assert.equal(calls[0]!.config.headers["x-simulated-trading"], "1");
  assert.equal(calls[0]!.config["axios-retry"].retries, 0);
});

test("okx live withdrawal omits the simulated-trading header when explicitly disabled", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  process.env.OKX_DEMO_MODE = "false";
  const calls = mockPost({ code: "0", data: [{ wdId: "WD2" }] });
  await withdrawUsdt("okx", CREDS, "10", "TAddr", "TRON", "req-5");
  assert.equal(calls[0]!.config.headers["x-simulated-trading"], undefined);
});

test("binance live withdrawal posts to the withdraw endpoint with retries disabled", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  const calls = mockPost({ id: "BID99" });
  const res = await withdrawUsdt("binance", CREDS, "25", "TAddr", "TRON", "req-6");
  assert.equal(res.transactionId, "BID99");
  assert.ok(calls[0]!.url.includes("/sapi/v1/capital/withdraw/apply"));
  assert.equal(calls[0]!.config["axios-retry"].retries, 0);
});

test("throws and tags the exchange when the API returns a failure code", async () => {
  process.env.PROFIT_WITHDRAWAL_MODE = "live";
  mockPost({ code: "40001", msg: "bad request", data: null });
  await assert.rejects(
    () => withdrawUsdt("bitget", CREDS, "10", "TAddr", "TRON", "req-7"),
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
    () => withdrawUsdt("okx", CREDS, "10", "TAddr", "TRON", "req-8"),
    (err: any) => {
      assert.equal(err.exchange, "okx");
      assert.match(err.message, /network down/);
      return true;
    },
  );
});
