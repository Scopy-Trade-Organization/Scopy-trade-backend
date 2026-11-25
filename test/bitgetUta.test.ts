import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { http } from "../src/services/exchangeConnectionService.js";
import { getExchangeBalance, getCurrentPrice, placeOrder, amendTradeOrder } from "../src/services/tradeService.js";
import { hasProtection, position, readConfirmedExit, readEntry, repairProtection, setBitgetPositionProtection, type ProtectedOrder } from "../src/services/tradeProtectionService.js";
import { assertSymbolFree } from "../src/services/futuresExchangeService.js";
import { bitgetPositions } from "../src/services/bitgetUtaService.js";
import { TradeMonitorService } from "../src/services/tradeMonitorService.js";
import { exchangeApi, type ExchangeRequest } from "../src/services/exchangeApiService.js";

const credentials = { apiKey: "test-key", apiSecret: "test-secret", passphrase: "test-passphrase" };
const p: ProtectedOrder = { credentials, pair: "BTCUSDT", direction: "buy", orderId: "entry", clientOrderId: "sc123", quantity: "0.01", orderQuantity: "0.01", entryPrice: "60000", tp: "62000", sl: "59000", marginMode: "isolated" };
const sizing: any = { orderQuantity: "0.01", positionQuantity: "0.01", entryPrice: "60000", takeProfitPrice: "62000", stopLossPrice: "59000", riskAmount: "30", takerFeeRate: "0.0006", exchangeInstrumentRules: { contractSize: "1" } };
const entry = { orderId: "entry", clientOid: "sc123", category: "USDT-FUTURES", symbol: "BTCUSDT", qty: "0.01", price: "60000", cumExecQty: "0", avgPrice: "0", orderStatus: "live", takeProfit: "62000", stopLoss: "59000", slTriggerBy: "mark", tpTriggerBy: "mark", slOrderType: "market", tpOrderType: "market" };

test("UTA HTTP rejections retain safe exchange codes while uncertain submissions require reconciliation", async t => {
  let code = "40017";
  let httpFailure = true;
  t.mock.method(http, "request", async () => {
    const data = { code, msg: credentials.apiSecret };
    if (httpFailure) throw { isAxiosError: true, response: { status: 400, data } };
    return { data };
  });
  const request = exchangeApi("bitget", credentials);
  await assert.rejects(request("POST", "/api/v3/trade/place-order", { clientOid: "sc123" }), (error: any) =>
    error.code === "EXCHANGE_REJECTED" && error.message.includes("40017") && !error.message.includes(credentials.apiSecret));
  for (code of ["40010", "40725", "45001"]) {
    for (httpFailure of [true, false]) {
      await assert.rejects(request("POST", "/api/v3/trade/place-order", { clientOid: "sc123" }), { code: "EXCHANGE_UNAVAILABLE" });
    }
  }
});

test("UTA missing-parameter errors preserve the parameter and endpoint on both HTTP and API failures", async t => {
  let httpFailure = false;
  let msg = "Parameter posSide cannot be empty";
  t.mock.method(http, "request", async () => {
    const data = { code: "40019", msg };
    if (httpFailure) throw { isAxiosError: true, response: { status: 400, data }, config: { headers: credentials } };
    return { data };
  });
  for (httpFailure of [false, true]) {
    await assert.rejects(exchangeApi("bitget", credentials)("POST", "/api/v3/trade/place-strategy-order", {}), (error: any) => {
      assert.equal(error.code, "EXCHANGE_REJECTED");
      assert.match(error.message, /Parameter posSide cannot be empty/);
      assert.deepEqual(error.details, { endpoint: "/api/v3/trade/place-strategy-order", method: "POST", exchangeCode: "40019", parameter: "posSide" });
      return true;
    });
    for (msg of [credentials.apiSecret, `Parameter ${credentials.apiKey} cannot be empty`, "Parameter posSide cannot be empty\nsecret signed request"]) {
      await assert.rejects(exchangeApi("bitget", credentials)("POST", "/api/v3/trade/place-strategy-order", {}), (error: any) => {
        assert.equal(error.details.parameter, undefined);
        assert.equal(JSON.stringify(error).includes(credentials.apiKey), false);
        assert.equal(error.message.includes(credentials.apiSecret), false);
        assert.equal(error.message.includes("signed request"), false);
        return true;
      });
    }
    msg = "Parameter posSide cannot be empty";
  }
});

test("UTA mismatch snapshots expose expected and observed protection fields without unrelated account data", async () => {
  const reports: any[] = [];
  const api: ExchangeRequest = async (_method, path) => ({ data: path.endsWith("order-info")
    ? { ...entry, orderStatus: "filled", cumExecQty: "0.01", apiSecret: credentials.apiSecret }
    : path.endsWith("current-position") ? { list: [{ symbol: "BTCUSDT", category: "USDT-FUTURES", total: "0.01", posSide: "long", holdMode: "one_way_mode", marginMode: "isolated" }] }
    : [{ ...entry, status: "pending", side: "sell", posSide: "long", slTriggerBy: "market", apiKey: credentials.apiKey, account: { secret: credentials.apiSecret } }] });
  assert.equal(await hasProtection("bitget", p, api, (code, details) => reports.push({ code, details })), false);
  const report = reports[0];
  assert.equal(report.code, "NATIVE_PROTECTION_MISMATCH");
  assert.equal(report.details.expected.slTriggerBy, "mark");
  assert.equal(report.details.strategies[0].slTriggerBy, "market");
  assert.equal(report.details.stopLossConfirmed, false);
  assert.equal(report.details.takeProfitConfirmed, true);
  assert.equal(JSON.stringify(reports).includes(credentials.apiSecret), false);
  assert.equal(JSON.stringify(reports).includes(credentials.apiKey), false);
});

test("UTA direct and nested position arrays work for both exposure checks and monitoring", async () => {
  const live = { symbol: "BTCUSDT", category: "USDT-FUTURES", holdMode: "one_way_mode", marginMode: "isolated", posSide: "long", total: "0.01" };
  for (const nested of [false, true]) {
    let occupied = false;
    const api: ExchangeRequest = async (method, path) => {
      assert.equal(method, "GET");
      if (path.endsWith("current-position")) {
        const rows = occupied ? [live] : [];
        return { code: "00000", data: nested ? { list: rows } : rows };
      }
      return { code: "00000", data: path.endsWith("unfilled-orders") ? { list: [] } : [] };
    };
    await assertSymbolFree("bitget", api, "BTCUSDT");
    assert.equal(await position("bitget", api, "BTCUSDT"), undefined);
    occupied = true;
    await assert.rejects(assertSymbolFree("bitget", api, "BTCUSDT"), { code: "EXISTING_EXPOSURE" });
    assert.deepEqual(await position("bitget", api, "BTCUSDT"), live);
  }
});

test("UTA malformed position envelopes stay unverifiable and diagnostics contain only types", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));
  for (const data of [undefined, null, {}, { list: null, cursor: "more" }, { list: "private-account-value" }, "private-account-value"]) {
    const api: ExchangeRequest = async (_method, path) => ({ code: "00000", data: path.endsWith("current-position") ? data : path.endsWith("unfilled-orders") ? { list: [] } : [] });
    await assert.rejects(assertSymbolFree("bitget", api, "BTCUSDT"), { code: "INVALID_EXCHANGE_RESPONSE" });
    await assert.rejects(position("bitget", api, "BTCUSDT"), { code: "INVALID_EXCHANGE_RESPONSE" });
  }
  assert.equal(logs.length, 12);
  assert.ok(!JSON.stringify(logs).includes("private-account-value"));
  assert.ok(JSON.stringify(logs).includes('"dataType":"null"'));
});

test("UTA successful null position lists are empty in planning and monitoring", async () => {
  for (const marker of [undefined, null, ""]) {
    const api: ExchangeRequest = async (_method, path) => ({ code: "00000", data:
      path.endsWith("current-position") ? { list: null, cursor: marker, endId: marker }
        : path.endsWith("unfilled-orders") ? { list: [] } : [] });
    await assertSymbolFree("bitget", api, "BTCUSDT");
    assert.equal(await position("bitget", api, "BTCUSDT"), undefined);
  }
});

test("UTA null lists never hide failed responses or additional position pages", t => {
  t.mock.method(console, "warn", () => {});
  for (const response of [
    { code: "40014", data: { list: null } },
    { data: { list: null } },
    { code: "00000", data: null },
    { code: "00000", data: {} },
    { code: "00000", data: { list: null, cursor: "more" } },
    { code: "00000", data: { list: null, endId: "more" } },
    { code: "00000", data: { list: null }, cursor: "more" },
    { code: "00000", data: { list: null }, endId: "more" },
  ]) assert.throws(() => bitgetPositions(response), { code: "INVALID_EXCHANGE_RESPONSE" });
});

test("UTA places a native v3 isolated entry with mark-price market TP/SL", async t => {
  t.mock.method(http, "request", async (options: any) => {
    assert.ok(options.url.endsWith("/api/v3/trade/place-order"));
    assert.equal(options["axios-retry"].retries, 0);
    assert.deepEqual(JSON.parse(options.data), { symbol: "BTCUSDT", category: "USDT-FUTURES", marginMode: "isolated", qty: "0.01", price: "60000", side: "buy", orderType: "limit", timeInForce: "gtc", clientOid: "sc123", takeProfit: "62000", stopLoss: "59000", tpTriggerBy: "mark", slTriggerBy: "mark", tpOrderType: "market", slOrderType: "market" });
    return { data: { code: "00000", data: { orderId: "entry" } } };
  });
  assert.equal((await placeOrder("bitget", { ...p, sizing })).orderId, "entry");
});

test("UTA account equity includes locked assets and a valid zero balance stays zero", async t => {
  let empty = false;
  t.mock.method(http, "request", async (options: any) => {
    assert.ok(options.url.endsWith("/api/v3/account/assets"));
    return { data: { code: "00000", data: { usdtEquity: empty ? "0" : "125", assets: empty ? [] : [{ coin: "USDT", equity: "125", available: "100", locked: "25" }] } } };
  });
  assert.deepEqual(await getExchangeBalance("bitget", credentials), { balances: [{ asset: "USDT", free: "100", locked: "25" }], totalUsdtEquivalent: "125" });
  empty = true;
  assert.deepEqual(await getExchangeBalance("bitget", credentials), { balances: [], totalUsdtEquivalent: "0" });
});

test("UTA price reads use the v3 ticker schema; Bybit price reads still work", async t => {
  t.mock.method(http, "get", async (url: string, options: any) => {
    if (url.includes("bybit")) return { data: { retCode: 0, result: { list: [{ lastPrice: "60001" }] } } };
    assert.ok(url.endsWith("/api/v3/market/tickers"));
    assert.deepEqual(options.params, { symbol: "BTCUSDT", category: "USDT-FUTURES" });
    return { data: { code: "00000", data: [{ symbol: "BTCUSDT", lastPrice: "60000" }] } };
  });
  assert.equal((await getCurrentPrice("bitget", "BTC/USDT")).price, "60000");
  assert.equal((await getCurrentPrice("bybit", "BTC/USDT")).price, "60001");
});

test("UTA pending amendments use the stable order ID and confirm native protection", async t => {
  const mutations: any[] = [];
  t.mock.method(http, "request", async (options: any) => {
    const path = new URL(options.url).pathname;
    if (options.method === "POST") {
      assert.equal(path, "/api/v3/trade/modify-order");
      mutations.push(JSON.parse(options.data));
      return { data: { code: "00000", data: { orderId: "entry" } } };
    }
    return { data: { code: "00000", data: path.endsWith("order-info") ? entry : { list: [] } } };
  });
  await amendTradeOrder("bitget", { ...p, sizing, status: "pending", entryChanged: true, protectionChanged: true });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].orderId, "entry");
  assert.equal(mutations[0].autoCancel, "no");
  assert.equal(mutations[0].stopLoss, "59000");
  assert.equal(mutations[0].newClientOid, undefined);
});

test("UTA partial fills stay pending and unknown states require review", async () => {
  const api: ExchangeRequest = async () => ({ data: { ...entry, orderStatus: "partially_filled", cumExecQty: "0.004", avgPrice: "60000" } });
  const read = await readEntry("bitget", api, "BTCUSDT", "entry");
  assert.equal(read.pending, true); assert.equal(read.filled, true); assert.equal(read.price, "60000");
  await assert.rejects(readEntry("bitget", async () => ({ data: { ...entry, orderStatus: "unknown" } }), "BTCUSDT", "entry"), { code: "ORDER_REVIEW_REQUIRED" });
});

test("UTA protection must cover the position on the correct side with mark triggers", async () => {
  let wrong = "";
  const api: ExchangeRequest = async (_method, path) => ({ data: path.endsWith("order-info") ? { ...entry, cumExecQty: "0.01", orderStatus: "filled" }
    : path.endsWith("current-position") ? { list: [{ symbol: "BTCUSDT", category: "USDT-FUTURES", total: "0.01", posSide: "long", holdMode: "one_way_mode", marginMode: "isolated", avgPrice: "60000", liquidationPrice: "50000" }] }
    : [{ ...entry, orderId: "stop", side: wrong === "side" ? "buy" : "sell", posSide: "long", status: "pending", qty: wrong === "quantity" ? "0.005" : "0.01", slTriggerBy: wrong === "trigger" ? "market" : "mark" }] });
  assert.equal(await hasProtection("bitget", { ...p, sizing }, api), true);
  for (wrong of ["side", "quantity", "trigger"]) assert.equal(await hasProtection("bitget", { ...p, sizing }, api), false);
});

test("UTA modifies existing separate TP/SL legs and refuses ambiguous protection", async () => {
  let duplicate = false;
  const mutations: any[] = [];
  const rows = [{ ...entry, orderId: "sl", status: "pending", side: "sell", takeProfit: "" }, { ...entry, orderId: "tp", status: "pending", side: "sell", stopLoss: "" }];
  const api: ExchangeRequest = async (method, path, values) => {
    if (method === "GET") return { data: duplicate ? [...rows, rows[0]] : rows };
    assert.equal(path, "/api/v3/trade/modify-strategy-order"); mutations.push(values); return {};
  };
  await setBitgetPositionProtection(api, "BTCUSDT", p, "0.01");
  assert.equal(mutations.length, 2);
  assert.equal(mutations[0].stopLoss, "59000"); assert.equal(mutations[1].takeProfit, "62000");
  duplicate = true;
  await assert.rejects(setBitgetPositionProtection(api, "BTCUSDT", p, "0.01"), { code: "PROTECTION_ID_UNAVAILABLE" });
  assert.equal(mutations.length, 2);
});

test("UTA missed exits use v3 cumulative fills and weighted actual prices", async () => {
  const api: ExchangeRequest = async (_method, path) => {
    assert.equal(path, "/api/v3/trade/history-orders");
    return { data: { list: [
      { createdTime: "1100", orderStatus: "filled", side: "sell", reduceOnly: "YES", cumExecQty: "0.004", avgPrice: "61000" },
      { createdTime: "1200", orderStatus: "filled", side: "sell", reduceOnly: "YES", cumExecQty: "0.006", avgPrice: "62000" },
    ] } };
  };
  const read: any = { row: { createdTime: "1000", cumExecQty: "0.01" } };
  assert.deepEqual(await readConfirmedExit("bitget", api, "BTCUSDT", read, "buy"), { exitPrice: "61600", orderQuantity: "0.01" });
});

test("UTA exit history follows cursors and rejects repeated incomplete pages", async () => {
  const cursors: unknown[] = [];
  let repeated = false;
  const api: ExchangeRequest = async (_method, _path, values) => {
    cursors.push(values?.cursor);
    const row = { createdTime: "1100", orderStatus: "filled", side: "sell", reduceOnly: "yes", cumExecQty: values?.cursor ? "0.006" : "0.004", avgPrice: values?.cursor ? "62000" : "61000" };
    return { data: { list: [row], cursor: !values?.cursor || repeated ? "next-page" : "" } };
  };
  const read: any = { row: { createdTime: "1000", cumExecQty: "0.01" } };
  assert.deepEqual(await readConfirmedExit("bitget", api, "BTCUSDT", read, "buy"), { exitPrice: "61600", orderQuantity: "0.01" });
  assert.deepEqual(cursors, [undefined, "next-page"]);
  repeated = true;
  await assert.rejects(readConfirmedExit("bitget", api, "BTCUSDT", read, "buy"), { code: "ORDER_REVIEW_REQUIRED" });
});

test("UTA partial-fill repair protects the remaining entry without repricing it", async () => {
  const mutations: Array<{ path: string; values: any }> = [];
  const api: ExchangeRequest = async (method, path, values) => {
    if (method === "POST") { mutations.push({ path, values }); return {}; }
    if (path.endsWith("order-info")) return { data: { ...entry, orderStatus: "partially_filled", cumExecQty: "0.004", avgPrice: "59900" } };
    if (path.endsWith("current-position")) return { data: { list: [{ symbol: "BTCUSDT", category: "USDT-FUTURES", holdMode: "one_way_mode", marginMode: "isolated", total: "0.004", posSide: "long" }] } };
    return { data: [] };
  };
  await repairProtection("bitget", { ...p, entryPrice: "59900" }, api);
  assert.equal(mutations[0]!.path, "/api/v3/trade/modify-order");
  assert.equal(mutations[0]!.values.qty, "0.01");
  assert.equal(mutations[0]!.values.price, undefined);
  assert.equal(mutations[1]!.path, "/api/v3/trade/place-strategy-order");
  assert.equal(mutations[1]!.values.qty, "0.004");
  assert.equal(mutations[1]!.values.reduceOnly, "yes");
});

test("UTA order stream subscribes with topic and reconciles entries and reduce-only exits", async t => {
  const monitor = new TradeMonitorService() as any;
  const sent: any[] = [];
  const trade = { pair: "BTCUSDT", tradeId: "trade", exchangeOrderId: "entry" };
  const connection = { ws: { readyState: WebSocket.OPEN, send: (message: string) => sent.push(JSON.parse(message)) }, activeTrades: new Map([["entry", trade]]) };
  t.mock.method(console, "log", () => {});
  const reconciled: any[] = [];
  t.mock.method(monitor, "reconcileEntryOrder", async (_conn: any, value: any) => reconciled.push(value));
  monitor.subscribeBitgetOrders(connection);
  assert.deepEqual(sent, [{ op: "subscribe", args: [{ instType: "UTA", topic: "order" }] }]);
  for (const order of [{ symbol: "BTCUSDT", orderId: "entry" }, { symbol: "BTCUSDT", orderId: "exit", reduceOnly: "yes" }]) {
    await monitor.handleBitgetMessage(connection, { arg: { instType: "UTA", topic: "order" }, data: [order] });
  }
  assert.deepEqual(reconciled, [trade, trade]);
});

test("UTA monitoring is connected only after subscription acknowledgement", async t => {
  const monitor = new TradeMonitorService() as any;
  t.mock.method(console, "log", () => {});
  const states: string[] = [];
  let closed = false;
  t.mock.method(monitor, "setConnectionMonitoringState", async (_connection: any, state: string) => states.push(state));
  const connection = { isConnected: false, reconnectAttempts: 2, ws: { readyState: WebSocket.OPEN, send() {}, close() { closed = true; } } };
  await monitor.handleBitgetMessage(connection, { event: "login", code: "0" });
  assert.equal(connection.isConnected, false);
  await monitor.handleBitgetMessage(connection, { event: "subscribe", arg: { instType: "UTA", topic: "order" } });
  assert.equal(connection.isConnected, true);
  assert.equal(connection.reconnectAttempts, 0);
  await monitor.handleBitgetMessage(connection, { event: "error", code: "30002" });
  assert.equal(connection.isConnected, false);
  assert.equal(closed, true);
  assert.deepEqual(states, ["connected", "reconnecting"]);
});
