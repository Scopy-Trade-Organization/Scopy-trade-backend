import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { http, validateCredentials, normalizeError, credentialValidationMessage } from "../src/services/exchangeConnectionService.js";

const credentials = { apiKey: "private-key", apiSecret: "private-secret", passphrase: "private-passphrase" };

test("Bitget HTTP errors preserve a safe actionable reason without logging credentials", async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  for (const [code, expected] of [["40038", /outbound IP.*whitelist/], ["40036", /API passphrase/], ["40008", /server clock/], ["40009", /signature/], ["40014", /permissions/], ["40037", /API key/]] as const) {
    const error = normalizeError({ isAxiosError: true, response: { status: 400, data: { code, msg: JSON.stringify(credentials) } }, config: { headers: credentials } }, "bitget");
    assert.match(credentialValidationMessage(error), expected);
    assert.match(error.message, new RegExp(code));
  }
  const output = JSON.stringify(logs);
  for (const secret of Object.values(credentials)) assert.ok(!output.includes(secret));
  const unknown = normalizeError({ isAxiosError: true, response: { status: 400, data: { code: "99999", msg: credentials.apiSecret } } }, "bitget");
  assert.match(unknown.message, /99999/);
  assert.ok(!unknown.message.includes(credentials.apiSecret));
  assert.ok(!credentialValidationMessage(new Error(credentials.apiSecret)).includes(credentials.apiSecret));
});

test("Bitget validates metadata and futures access in the configured mode and signs the full query", async (t) => {
  const previous = process.env.EXCHANGE_MODE;
  t.after(() => { if (previous === undefined) delete process.env.EXCHANGE_MODE; else process.env.EXCHANGE_MODE = previous; });
  let rejectFutures = false;
  t.mock.method(http, "get", async (_url: string, options: any) => {
    assert.equal(options.headers.paptrading, process.env.EXCHANGE_MODE === "testnet" ? "1" : undefined);
    return { data: { code: "00000", data: { userId: "123", authorities: ["coow", "cpow"] } } };
  });
  t.mock.method(http, "request", async (options: any) => {
    assert.equal(options.headers.paptrading, process.env.EXCHANGE_MODE === "testnet" ? "1" : undefined);
    const target = new URL(options.url).pathname + new URL(options.url).search;
    assert.equal(target, "/api/v2/mix/account/accounts?productType=USDT-FUTURES");
    assert.equal(options.headers["ACCESS-SIGN"], crypto.createHmac("sha256", credentials.apiSecret).update(options.headers["ACCESS-TIMESTAMP"] + "GET" + target).digest("base64"));
    return { data: { code: rejectFutures ? "40014" : "00000", msg: credentials.apiSecret } };
  });
  for (const mode of ["live", "testnet"]) {
    process.env.EXCHANGE_MODE = mode;
    assert.equal((await validateCredentials("bitget", credentials) as { userId: string }).userId, "123");
  }
  rejectFutures = true;
  await assert.rejects(validateCredentials("bitget", credentials), /permissions.*40014/);
});

test("Bitget HTTP 200 rejections also return safe error codes", async (t) => {
  t.mock.method(http, "get", async () => ({ data: { code: "40036", msg: credentials.passphrase } }));
  await assert.rejects(validateCredentials("bitget", credentials), /API passphrase.*40036/);
});

test("connect endpoint returns the Bitget rejection reason in its 422 response", async (t) => {
  const { ExchangeConnection } = await import("../src/models/exchangeConnectionModel.js");
  const { connectExchange } = await import("../src/controllers/exchangeController.js");
  t.mock.method(ExchangeConnection, "findOne", async () => null);
  t.mock.method(http, "get", async () => {
    throw { isAxiosError: true, response: { status: 400, data: { code: "40038", msg: credentials.apiSecret } } };
  });
  t.mock.method(console, "error", () => {});
  let status: number | undefined;
  let body: any;
  const response = { status(value: number) { status = value; return this; }, json(value: any) { body = value; return this; } };
  await connectExchange({ user: "test-user", body: { exchange: "bitget", ...credentials } } as any, response as any);
  assert.equal(status, 422);
  assert.match(body.message, /outbound IP.*whitelist.*40038/);
  for (const secret of Object.values(credentials)) assert.ok(!JSON.stringify(body).includes(secret));
});
