import test from "node:test";
import assert from "node:assert/strict";
import { hasProtection, verifyOrRecoverProtection, readConfirmedExit, ProtectionFailure, type ProtectedOrder } from "../src/services/tradeProtectionService.js";
import { closeTradeOrder, resolveExchangeOrderId } from "../src/services/tradeService.js";
import type { ExchangeId } from "../src/types/index.js";
import type { ExchangeRequest } from "../src/services/exchangeApiService.js";

const order: ProtectedOrder = { credentials: { apiKey: "test", apiSecret: "test", passphrase: "test" }, pair: "BTCUSDT", direction: "buy",
  orderId: "entry", clientOrderId: "sc123", quantity: "1", orderQuantity: "1", entryPrice: "100", sl: "95", tp: "110", marginMode: "isolated" };
function fixture(exchange: ExchangeId, filled = false, repairWorks = false) {
  let protectedOrder = false, cancelled = false, closed = false;
  const mutations: Array<{ path: string; values: any }> = [];
  const entry = (): any => exchange === "bybit" ? { orderId: "entry", qty: "1", price: "100", orderStatus: cancelled ? "Cancelled" : filled ? "Filled" : "New", cumExecQty: filled ? "1" : "0", avgPrice: filled ? "100" : "", ...(protectedOrder ? { stopLoss: "95", takeProfit: "110", tpslMode: "Full", slLimitPrice: "", slTriggerBy: "MarkPrice" } : {}) }
    : exchange === "okx" ? { ordId: "entry", sz: "1", px: "100", state: cancelled ? "canceled" : filled ? "filled" : "live", accFillSz: filled ? "1" : "0", avgPx: filled ? "100" : "", attachAlgoOrds: protectedOrder ? [{ slTriggerPx: "95", tpTriggerPx: "110", slOrdPx: "-1" }] : [] }
    : { orderId: "entry", qty: "1", price: "100", orderStatus: cancelled ? "cancelled" : filled ? "filled" : "live", cumExecQty: filled ? "1" : "0", avgPrice: filled ? "100" : "", ...(protectedOrder ? { stopLoss: "95", takeProfit: "110", slTriggerBy: "mark", tpTriggerBy: "mark", slOrderType: "market", tpOrderType: "market" } : {}) };
  const live = () => !filled || closed ? [] : exchange === "bybit" ? [{ size: "1", side: "Buy", avgPrice: "100", liqPrice: "50", ...(protectedOrder ? { stopLoss: "95", takeProfit: "110" } : {}) }]
    : exchange === "okx" ? [{ pos: "1", avgPx: "100", liqPx: "50" }] : [{ total: "1", symbol: "BTCUSDT", category: "USDT-FUTURES", holdMode: "one_way_mode", marginMode: "isolated", posSide: "long", avgPrice: "100", liquidationPrice: "50" }];
  const request: ExchangeRequest = async (method, path, values = {}) => {
    if (method === "POST") {
      mutations.push({ path, values });
      if (path.includes("cancel")) { cancelled = true; return {}; }
      if (values.reduceOnly && (values.ordType === "market" || values.orderType === "Market" || values.orderType === "market")) {
        closed = true;
        return exchange === "bybit" ? { result: { orderId: "exit" } } : exchange === "okx" ? { data: [{ ordId: "exit" }] } : { data: { orderId: "exit" } };
      }
      if (!repairWorks) throw new Error("Protection rejected");
      protectedOrder = true;
      return {};
    }
    if (path.includes("position/list")) return { result: { list: live() } };
    if (path.includes("account/positions")) return { data: live() };
    if (path.includes("current-position")) return { data: { list: live() } };
    if (path.includes("orders-algo-pending")) return { data: protectedOrder ? [{ slTriggerPx: "95", tpTriggerPx: "110", slOrdPx: "-1", sz: "1", side: "sell" }] : [] };
    if (path.includes("unfilled-strategy-orders")) return { data: protectedOrder ? [{ orderId: "protection", category: "USDT-FUTURES", symbol: "BTCUSDT", status: "pending", side: "sell", posSide: "long", qty: "1", stopLoss: "95", takeProfit: "110", slTriggerBy: "mark", tpTriggerBy: "mark", slOrderType: "market", tpOrderType: "market" }] : [] };
    const isExit = values.orderId === "exit" || values.ordId === "exit";
    const row: any = isExit ? exchange === "bybit" ? { orderId: "exit", qty: "1", orderStatus: "Filled", cumExecQty: "1", avgPrice: "99" } : exchange === "okx" ? { ordId: "exit", sz: "1", state: "filled", accFillSz: "1", avgPx: "99" } : { orderId: "exit", qty: "1", orderStatus: "filled", cumExecQty: "1", avgPrice: "99" } : entry();
    return exchange === "bybit" ? { result: { list: [row] } } : exchange === "okx" ? { data: [row] } : { data: row };
  };
  return { request, mutations, protect: () => { protectedOrder = true; } };
}
for (const exchange of ["bybit", "okx", "bitget"] as const) {
  test(`${exchange}: recover the exact order by saved client ID using only reads`, async () => {
    const row = exchange === "bybit" ? { orderId: "recovered", orderLinkId: "sc123" }
      : exchange === "okx" ? { ordId: "recovered", clOrdId: "sc123" }
      : { orderId: "recovered", clientOid: "sc123", orderStatus: "live", qty: "1", cumExecQty: "0" };
    const api: ExchangeRequest = async (method, _path, values) => {
      assert.equal(method, "GET");
      assert.equal(values?.orderId ?? values?.ordId, undefined);
      assert.equal(values?.orderLinkId ?? values?.clOrdId ?? values?.clientOid, "sc123");
      return exchange === "bybit" ? { result: { list: [row] } } : exchange === "okx" ? { data: [row] } : { data: row };
    };
    assert.equal(await resolveExchangeOrderId(exchange, order.credentials, order.pair, "sc123", api), "recovered");
  });
  test(`${exchange}: missing identifiers never issue an unfiltered lookup`, async () => {
    let calls = 0;
    await assert.rejects(resolveExchangeOrderId(exchange, order.credentials, order.pair, null, async () => { calls++; }), { code: "ORDER_REVIEW_REQUIRED" });
    assert.equal(calls, 0);
  });
  test(`${exchange}: unrelated, malformed and unavailable orders remain under review`, async () => {
    for (const row of [{ orderId: "other", ordId: "other", orderLinkId: "other", clOrdId: "other", clientOid: "other" }, {}, null]) {
      const api: ExchangeRequest = async () => exchange === "bybit" ? { result: { list: row ? [row] : [] } } : exchange === "okx" ? { data: row ? [row] : [] } : { data: row };
      await assert.rejects(resolveExchangeOrderId(exchange, order.credentials, order.pair, "sc123", api), { code: "ORDER_REVIEW_REQUIRED" });
    }
    await assert.rejects(resolveExchangeOrderId(exchange, order.credentials, order.pair, "sc123", async () => { throw new Error("Timeout"); }), { code: "ORDER_REVIEW_REQUIRED" });
  });
  test(`${exchange}: confirmed pending native TP/SL passes read-back without recovery`, async () => {
    const f = fixture(exchange);
    f.protect();
    await verifyOrRecoverProtection(exchange, order, f.request);
    assert.equal(f.mutations.length, 0);
  });
  test(`${exchange}: manual close uses opposite reduce-only side and confirmed fill price`, async () => {
    const f = fixture(exchange, true);
    const result = await closeTradeOrder(exchange, { credentials: order.credentials, pair: order.pair, direction: "buy", quantity: "1", orderId: "entry", status: "filled" }, f.request);
    assert.equal(result.exitPrice, "99"); assert.equal(result.closedQuantity, "1");
    assert.equal(f.mutations.length, 1); assert.ok(f.mutations[0]!.values.reduceOnly);
  });
  test(`${exchange}: accepted entry with missing SL is cancelled, never successful`, async () => {
    const f = fixture(exchange);
    await assert.rejects(verifyOrRecoverProtection(exchange, order, f.request), (error: any) => error instanceof ProtectionFailure && error.recovery === "cancelled");
    assert.ok(f.mutations.some(m => m.path.includes("cancel")));
    assert.equal(f.mutations.filter(m => m.values.reduceOnly).length, 0);
  });
  test(`${exchange}: failed protection closes filled position reduce-only and reads actual exit`, async () => {
    const f = fixture(exchange, true);
    await assert.rejects(verifyOrRecoverProtection(exchange, order, f.request), (error: any) => error instanceof ProtectionFailure && error.recovery === "closed" && error.exitPrice === "99" && error.closedQuantity === "1");
    const close = f.mutations.find(m => m.values.reduceOnly)!;
    assert.ok(close);
    assert.equal(close.values.side.toLowerCase(), "sell");
  });
  test(`${exchange}: successful repair must be read back before success`, async () => {
    const f = fixture(exchange, true, true);
    assert.equal(await hasProtection(exchange, order, f.request), false);
    await verifyOrRecoverProtection(exchange, order, f.request);
    assert.equal(await hasProtection(exchange, order, f.request), true);
    assert.equal(f.mutations.filter(m => m.values.orderType === "market" || m.values.orderType === "Market" || m.values.ordType === "market").length, 0);
  });
}
test("unavailable read-back and recovery stays unresolved rather than inventing success", async () => {
  const unavailable: ExchangeRequest = async () => { throw new Error("Timeout"); };
  await assert.rejects(verifyOrRecoverProtection("bybit", order, unavailable), (error: any) => error instanceof ProtectionFailure && error.recovery === "review" && error.exitPrice === null);
});

test("missed exits require exact cumulative filled quantity and use weighted actual prices", async () => {
  const entry: any = { row: { createdTime: "1000", cumExecQty: "1" } };
  const rows = [
    { createdTime: "1100", orderStatus: "Filled", side: "Sell", reduceOnly: true, cumExecQty: "0.4", avgPrice: "98" },
    { createdTime: "1200", orderStatus: "Filled", side: "Sell", reduceOnly: true, cumExecQty: "0.6", avgPrice: "100" },
    { createdTime: "900", orderStatus: "Filled", side: "Sell", reduceOnly: true, cumExecQty: "1", avgPrice: "200" },
  ];
  const api: ExchangeRequest = async () => ({ result: { list: rows } });
  const exit = await readConfirmedExit("bybit", api, "BTCUSDT", entry, "buy");
  assert.equal(exit?.exitPrice, "99.2"); assert.equal(exit?.orderQuantity, "1");
  rows.pop(); rows.pop();
  assert.equal(await readConfirmedExit("bybit", api, "BTCUSDT", entry, "buy"), null);
});

test("Bybit pending full-position protection must not specify a stop limit execution price", async () => {
  const f = fixture("bybit"); f.protect();
  const api: ExchangeRequest = async (method, path, values) => {
    const result = await f.request(method, path, values);
    if (path === "/v5/order/realtime") result.result.list[0].slLimitPrice = "94";
    return result;
  };
  assert.equal(await hasProtection("bybit", order, api), false);
});
