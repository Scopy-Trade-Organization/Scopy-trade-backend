import test from "node:test";
import assert from "node:assert/strict";
import { SUPPORTED_PAIRS } from "../src/constants.js";
import { configureBitgetSupportedPairs, prepareBitgetPair } from "../src/services/bitgetSetupService.js";
import type { ExchangeRequest } from "../src/services/exchangeApiService.js";

const credentials = { apiKey: "test", apiSecret: "test", passphrase: "test" };
function fixture() {
  const modes = new Map<string, string>();
  const leverages = new Map<string, string>();
  const occupied = new Set<string>();
  const orders = new Set<string>();
  const strategies = new Set<string>();
  const mutations: Array<{ path: string; values: any }> = [];
  let holdMode = "one_way_mode", unconfirmed = false;
  const api: ExchangeRequest = async (method, path, values = {}) => {
    if (method === "POST") {
      mutations.push({ path, values });
      assert.equal(path, "/api/v3/account/set-leverage");
      assert.equal(values.marginMode, "isolated");
      assert.ok(SUPPORTED_PAIRS.includes(values.symbol));
      assert.ok(!occupied.has(values.symbol) && !orders.has(values.symbol) && !strategies.has(values.symbol));
      if (!unconfirmed) { modes.set(values.symbol, "isolated"); leverages.set(values.symbol, values.leverage); }
      return { code: "00000", data: "success" };
    }
    if (path.endsWith("/settings")) return { data: { accountMode: "unified", accountLevel: "basic", holdMode, deltaSwitch: "no", symbolConfigList: [...modes].map(([symbol, marginMode]) => ({ symbol, marginMode, category: "USDT-FUTURES", leverage: leverages.get(symbol) || "20" })) } };
    if (path.endsWith("/instruments")) return { data: [{ symbol: values.symbol, category: "USDT-FUTURES", status: "online", quoteCoin: "USDT", type: "perpetual", minLeverage: "1" }] };
    if (path.endsWith("/current-position")) return { code: "00000", data: { list: occupied.has(values.symbol) ? [{ total: "1", holdMode }] : null } };
    if (path.endsWith("/unfilled-orders")) return { data: { list: orders.has(values.symbol) ? [{ orderId: "manual" }] : [] } };
    if (path.endsWith("/unfilled-strategy-orders")) return { data: [...strategies].map(symbol => ({ symbol, category: "USDT-FUTURES", orderId: "manual-stop" })) };
    throw new Error(`Unexpected setup call: ${path}`);
  };
  return { api, modes, leverages, occupied, orders, strategies, mutations, hedge: () => { holdMode = "hedge_mode"; }, noReadback: () => { unconfirmed = true; } };
}

test("automatic setup covers the ten pairs offered by the frontend and is idempotent", async () => {
  assert.deepEqual([...SUPPORTED_PAIRS], ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "BNBUSDT", "LINKUSDT", "SUIUSDT", "AVAXUSDT", "ADAUSDT"]);
  const f = fixture();
  const first = await configureBitgetSupportedPairs(credentials, f.api);
  assert.equal(first.pairs.length, 10);
  assert.ok(first.pairs.every(pair => pair.status === "configured"));
  assert.equal(f.mutations.length, 20);
  for (const symbol of SUPPORTED_PAIRS) {
    assert.deepEqual(f.mutations.filter(m => m.values.symbol === symbol).map(m => m.values.posSide), ["long", "short"]);
  }
  const next = await configureBitgetSupportedPairs(credentials, f.api);
  assert.ok(next.pairs.every(pair => pair.status === "ready"));
  assert.equal(f.mutations.length, 20);
});

test("existing positions, ordinary orders and strategy orders block only the affected pairs", async () => {
  const f = fixture();
  f.occupied.add("BTCUSDT"); f.orders.add("ETHUSDT"); f.strategies.add("LINKUSDT");
  const result = await configureBitgetSupportedPairs(credentials, f.api);
  assert.deepEqual(result.pairs.filter(p => p.status === "blocked").map(p => p.symbol), ["BTCUSDT", "ETHUSDT", "LINKUSDT"]);
  assert.equal(result.pairs.filter(p => p.status === "configured").length, 7);
  assert.ok(f.mutations.every(m => !["BTCUSDT", "ETHUSDT", "LINKUSDT"].includes(m.values.symbol)));
  f.orders.clear();
  assert.equal((await prepareBitgetPair(credentials, "ETHUSDT", f.api)).status, "configured");
});

test("setup preserves existing isolated leverage even when a position is active", async () => {
  const f = fixture();
  f.modes.set("LINKUSDT", "isolated"); f.leverages.set("LINKUSDT", "7"); f.occupied.add("LINKUSDT");
  assert.equal((await prepareBitgetPair(credentials, "LINKUSDT", f.api)).status, "ready");
  assert.equal(f.leverages.get("LINKUSDT"), "7");
  assert.equal(f.mutations.length, 0);
});

test("unsupported account mode, unconfirmed configuration and unsupported pairs never appear ready", async () => {
  const f = fixture(); f.hedge();
  assert.ok((await configureBitgetSupportedPairs(credentials, f.api)).pairs.every(p => p.status === "blocked"));
  assert.equal(f.mutations.length, 0);
  const missing = fixture(); missing.noReadback();
  await assert.rejects(prepareBitgetPair(credentials, "LINKUSDT", missing.api), { code: "UNSUPPORTED_MARGIN_MODE" });
  await assert.rejects(prepareBitgetPair(credentials, "NOTSUPPORTEDUSDT", f.api), { code: "UNSUPPORTED_INSTRUMENT" });
  assert.equal(f.mutations.length, 0);
});

test("exposure appearing during setup stops further configuration", async () => {
  const f = fixture();
  const api: ExchangeRequest = async (method, path, values, allowed) => {
    const result = await f.api(method, path, values, allowed);
    if (method === "POST") f.occupied.add("LINKUSDT");
    return result;
  };
  await assert.rejects(prepareBitgetPair(credentials, "LINKUSDT", api), { code: "EXISTING_EXPOSURE" });
  assert.equal(f.mutations.length, 1);
});
