import test from "node:test";
import assert from "node:assert/strict";
import { hasProtection, verifyOrRecoverProtection, setBitgetPositionProtection, type ProtectedOrder } from "../src/services/tradeProtectionService.js";
import type { ExchangeRequest } from "../src/services/exchangeApiService.js";

function fixture(direction: "buy" | "sell") {
  const short = direction === "sell";
  const order: ProtectedOrder = {
    credentials: { apiKey: "test", apiSecret: "test", passphrase: "test" },
    pair: "LINKUSDT", direction, orderId: "1509506647982886912", clientOrderId: "regression",
    quantity: "3", orderQuantity: "3", entryPrice: "8.541", tp: short ? "8.328" : "8.8", sl: short ? "8.8" : "8.328", marginMode: "isolated",
  };
  const levels = { takeProfit: order.tp, stopLoss: order.sl, tpTriggerBy: "mark", slTriggerBy: "mark", tpOrderType: "market", slOrderType: "market" };
  const entry = { ...levels, orderId: order.orderId, symbol: order.pair, category: "USDT-FUTURES", orderStatus: "filled",
    side: direction, posSide: short ? "short" : "long", qty: "3", cumExecQty: "3", price: order.entryPrice, avgPrice: "8.58" };
  const position = { symbol: order.pair, category: "USDT-FUTURES", posSide: entry.posSide, total: "3", holdMode: "one_way_mode", marginMode: "isolated" };
  const strategy = { ...levels, orderId: "1509506648016167025", symbol: order.pair, category: "USDT-FUTURES", status: "pending",
    side: short ? "buy" : "sell", posSide: short ? "long" : "short", qty: "3", tpLimitPrice: "", slLimitPrice: "" };
  let rows: any[] = [strategy];
  const writes: Array<{ path: string; values: any }> = [];
  const api: ExchangeRequest = async (method, path, values = {}) => {
    if (method === "POST") {
      writes.push({ path, values });
      if (path.endsWith("place-strategy-order")) {
        assert.equal(values.posSide, entry.posSide);
        assert.equal(values.reduceOnly, "yes");
        rows.push({ ...strategy, ...values, posSide: strategy.posSide });
        return { data: { orderId: strategy.orderId } };
      }
      if (path.endsWith("modify-strategy-order")) {
        Object.assign(rows.find(row => row.orderId === values.orderId), values);
        return {};
      }
      assert.fail(`Unexpected write: ${path}`);
    }
    if (path.endsWith("order-info")) return { data: entry };
    if (path.endsWith("current-position")) return { data: { list: [position] } };
    assert.ok(path.endsWith("unfilled-strategy-orders"));
    return { data: rows };
  };
  return { order, position, strategy, api, writes, setRows: (value: any[]) => { rows = value; } };
}

for (const direction of ["sell", "buy"] as const) {
  test(`Bitget ${direction}: execution-side strategy label confirms protection without repair or close`, async () => {
    const f = fixture(direction);
    await verifyOrRecoverProtection("bitget", f.order, f.api);
    assert.deepEqual(f.writes, []);
    // Both position-side and closing-order-side labels occur in responses.
    f.strategy.posSide = f.position.posSide;
    assert.equal(await hasProtection("bitget", f.order, f.api), true);
  });

  test(`Bitget ${direction}: protection checks still reject wrong side, levels, quantity, trigger and status`, async () => {
    const f = fixture(direction);
    for (const change of [{ side: direction }, { qty: "2" }, { stopLoss: "1" }, { takeProfit: "1" },
      { slTriggerBy: "market" }, { tpTriggerBy: "market" }, { slOrderType: "limit" }, { status: "cancelled" }, { posSide: "invalid" }]) {
      f.setRows([{ ...f.strategy, ...change }]);
      assert.equal(await hasProtection("bitget", f.order, f.api), false, JSON.stringify(change));
    }
    f.setRows([f.strategy]);
    f.position.holdMode = "hedge_mode";
    await assert.rejects(hasProtection("bitget", f.order, f.api), { code: "POSITION_CHANGED" });
  });

  test(`Bitget ${direction}: missing protection repair supplies position side and verifies returned protection`, async () => {
    const f = fixture(direction);
    f.setRows([]);
    await verifyOrRecoverProtection("bitget", f.order, f.api);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0]!.path, "/api/v3/trade/place-strategy-order");
    assert.equal(await hasProtection("bitget", f.order, f.api), true);
  });

  test(`Bitget ${direction}: repair recognizes an existing leg and supplies position side for the missing leg`, async () => {
    const f = fixture(direction);
    f.setRows([{ ...f.strategy, takeProfit: "" }]);
    await setBitgetPositionProtection(f.api, f.order.pair, f.order, "3");
    assert.deepEqual(f.writes.map(write => write.path), ["/api/v3/trade/modify-strategy-order", "/api/v3/trade/place-strategy-order"]);
    assert.equal(f.writes[1]!.values.stopLoss, undefined);
    assert.equal(f.writes[1]!.values.takeProfit, f.order.tp);
    assert.equal(await hasProtection("bitget", f.order, f.api), true);
  });
}
