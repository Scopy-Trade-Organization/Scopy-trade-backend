import axios from "axios";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { executeTrade, type ExecutionDependencies } from "../src/services/tradeExecutionService.js";
import { ExchangeConnection } from "../src/models/exchangeConnectionModel.js";
import { Trade } from "../src/models/tradeModel.js";
import User from "../src/models/userModel.js";
import { encryptCredentials, http } from "../src/services/exchangeConnectionService.js";
import { D, TradeRiskError, type InstrumentRules } from "../src/services/tradeRiskService.js";
import { ProtectionFailure, enforceStoredTradeProtection } from "../src/services/tradeProtectionService.js";
import { previewTradeWithDependencies } from "../src/controllers/tradeController.js";
import { closeProTrade } from "../src/controllers/proTraderDashboardController.js";
import { testConnection } from "../src/controllers/exchangeController.js";
import { setupBitgetConnection } from "../src/services/bitgetSetupService.js";

const rules: InstrumentRules = { symbol: "BTCUSDT", quantityStep: "0.0001", minimumQuantity: "0.0001", maximumQuantity: "100",
  minimumNotional: "5", priceTickSize: "0.1", contractSize: "1", minimumLeverage: "1", maximumLeverage: "100", leverageStep: "1",
  tiers: [{ maximumNotional: "1000000", maximumLeverage: "100", maintenanceRate: "0.005", initialMarginRate: "0.01", maintenanceDeduction: "0" }] };
let database: MongoMemoryReplSet;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 60_000 }] });
  await mongoose.connect(database.getUri());
  await Promise.all([Trade.init(), ExchangeConnection.init()]);
  process.env.EXCHANGE_ENCRYPTION_KEY = "1".repeat(64);
  process.env.EXCHANGE_MODE = "live";
  for (const key of ["GMAIL_SENDER_EMAIL", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]) process.env[key] = "test-only";
  test.mock.method(axios, "post", async () => ({ data: { access_token: "test-token", expires_in: 3600 } }));
});
after(async () => { await new Promise(resolve => setImmediate(resolve)); await mongoose.disconnect(); await database?.stop(); });
async function fixture(balance = "50") {
  const userId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: userId, email: `${userId}@example.com`, traderID: String(userId), status: "live", settlementOwedUnits: 0 });
  const encrypted = encryptCredentials("bybit", { apiKey: "test-key", apiSecret: "test-secret" });
  const connection = await ExchangeConnection.create({ userId, exchange: "bybit", encryptedApiKey: encrypted.apiKey, encryptedApiSecret: encrypted.apiSecret });
  let entries = 0, checks = 0, configured = false, submitted: any;
  const dependencies: ExecutionDependencies = {
    getCurrentPrice: async () => ({ price: "64755.1", raw: {} }),
    getFuturesContext: async () => ({ availableBalance: balance, accountBalance: "9999", takerFeeRate: "0.0006", marginMode: "isolated", rules }),
    configureLeverage: async () => { configured = true; },
    refreshAvailableFuturesBalance: async () => balance,
    placeOrder: async (_exchange, params) => {
      assert.equal(configured, true);
      assert.ok(await Trade.exists({ exchangeClientOrderId: params.clientOrderId, protectionStatus: "pending" }));
      entries++; submitted = params;
      return { orderId: "exchange-entry-" + userId, raw: {} };
    },
    verifyOrRecoverProtection: async () => { checks++; },
    startMonitoring: async () => {},
  };
  const body = { exchangeConnectionId: String(connection._id), pair: "BTCUSDT", entry: "64755.1", sl: "64949.3", tp: "64000", direction: "sell" };
  return { userId, connection, body, dependencies, entries: () => entries, checks: () => checks, submitted: () => submitted };
}

test("LINKUSDT pro payload opens a protected Bitget UTA trade through the real execution pipeline", async t => {
  // Public LINK instrument/tier fields verified against Bitget on 2026-11-25.
  // Private account, price and order responses are deterministic fixtures, not live orders.
  for (const filled of [false, true]) {
    const userId = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: userId, email: `${userId}@example.com`, traderID: String(userId), status: "live" });
    const encrypted = encryptCredentials("bitget", { apiKey: "test-key", apiSecret: "test-secret", passphrase: "test-passphrase" });
    const connection = await ExchangeConnection.create({ userId, exchange: "bitget", encryptedApiKey: encrypted.apiKey, encryptedApiSecret: encrypted.apiSecret, encryptedPassphrase: encrypted.passphrase });
    const payload = { pair: "LINKUSDT", entry: 8.618, tp: 8.561, sl: 8.65, direction: "sell", notes: "", balance: 51.24649142, exchangeConnectionId: String(connection._id) };
    let leverage = filled ? "1" : "20";
    let isolated = filled;
    const setupSides: string[] = [];
    let submitted: any;
    let submissions = 0;
    let protectionReads = 0;
    const orderId = `link-entry-${userId}`;
    const calls: string[] = [];
    const getMock = t.mock.method(http, "get", async (url: string) => {
      assert.ok(url.endsWith("/api/v3/market/tickers"));
      return { data: { code: "00000", data: [{ symbol: "LINKUSDT", lastPrice: "8.618" }] } };
    });
    const requestMock = t.mock.method(http, "request", async (options: any) => {
      const url = new URL(options.url), path = url.pathname;
      calls.push(path);
      assert.ok(path.startsWith("/api/v3/"));
      const body = options.data ? JSON.parse(options.data) : {};
      let data: any;
      switch (path) {
        case "/api/v3/position/current-position":
          data = { list: submitted && filled ? [{ category: "USDT-FUTURES", symbol: "LINKUSDT", holdMode: "one_way_mode", marginMode: "isolated", posSide: "short", total: submitted.qty, avgPrice: "8.618", liquidationPrice: "10", leverage }] : null };
          break;
        case "/api/v3/trade/unfilled-orders": data = { list: [] }; break;
        case "/api/v3/trade/unfilled-strategy-orders":
          data = submitted && filled ? [{ category: "USDT-FUTURES", symbol: "LINKUSDT", orderId: "protection", status: "pending", side: "buy", posSide: "short", qty: submitted.qty, takeProfit: "8.561", stopLoss: "8.65", tpTriggerBy: "mark", slTriggerBy: "mark", tpOrderType: "market", slOrderType: "market" }] : [];
          break;
        case "/api/v3/market/instruments":
          data = [{ symbol: "LINKUSDT", category: "USDT-FUTURES", quoteCoin: "USDT", status: "online", type: "perpetual", quantityMultiplier: "1", minOrderQty: "1", maxOrderQty: "49000", maxMarketOrderQty: "6500", priceMultiplier: "0.001", minOrderAmount: "5", minLeverage: "1", maxLeverage: "75", openCostUpRatio: "0.01" }];
          break;
        case "/api/v3/account/settings":
          data = { accountMode: "unified", accountLevel: "basic", holdMode: "one_way_mode", deltaSwitch: "no", symbolConfigList: [{ category: "USDT-FUTURES", symbol: "LINKUSDT", marginMode: isolated ? "isolated" : "crossed", leverage }] };
          break;
        case "/api/v3/account/assets":
          data = { usdtEquity: "51.24649142", assets: [{ coin: "USDT", equity: "51.24649142", available: "51.24649142", locked: "0" }] };
          break;
        case "/api/v3/market/position-tier": data = [{ tier: "1", minTierValue: "0", maxTierValue: "10000", leverage: "75", mmr: "0.0067" }]; break;
        case "/api/v3/account/fee-rate": data = { takerFeeRate: "0.0006" }; break;
        case "/api/v3/account/max-open-available":
          assert.equal(body.marginMode, "isolated"); data = { available: "51.24649142" }; break;
        case "/api/v3/account/set-leverage":
          if (body.leverage === "1") setupSides.push(body.posSide);
          else assert.equal(body.posSide, "short");
          assert.equal(body.marginMode, "isolated"); isolated = true; leverage = body.leverage; data = "success"; break;
        case "/api/v3/trade/place-order":
          assert.equal(options["axios-retry"].retries, 0);
          assert.equal(leverage, "5");
          assert.equal(body.side, "sell"); assert.equal(body.qty, "24"); assert.equal(body.price, "8.618");
          assert.equal(body.marginMode, "isolated"); assert.equal(body.timeInForce, "gtc");
          assert.equal(body.stopLoss, "8.65"); assert.equal(body.takeProfit, "8.561");
          assert.equal(body.slTriggerBy, "mark"); assert.equal(body.slOrderType, "market");
          assert.ok(await Trade.exists({ exchangeClientOrderId: body.clientOid, protectionStatus: "pending" }));
          submitted = body; submissions++; data = { orderId, clientOid: body.clientOid }; break;
        case "/api/v3/trade/order-info":
          protectionReads++;
          data = { ...submitted, orderId, orderStatus: filled ? "filled" : "live", cumExecQty: filled ? submitted.qty : "0", avgPrice: filled ? "8.618" : "0" }; break;
        default: throw new Error(`Unexpected Bitget request: ${path}`);
      }
      return { data: { code: "00000", data } };
    });
    try {
      const outcome = await executeTrade(userId, payload, true, { startMonitoring: async id => {
        assert.ok(protectionReads > 0);
        const setup = await setupBitgetConnection(String(connection._id), { apiKey: "test-key", apiSecret: "test-secret", passphrase: "test-passphrase" });
        assert.ok(setup.pairs.every(pair => pair.status === "blocked"));
        assert.equal(await enforceStoredTradeProtection(id), true);
      } });
      assert.equal(outcome.status, 201, JSON.stringify(outcome.body));
      assert.equal(submissions, 1);
      assert.equal(outcome.body.trade.exchangeOrderId, orderId);
      assert.equal(outcome.body.trade.status, filled ? "filled" : "pending");
      assert.equal(outcome.body.trade.protectionStatus, "confirmed");
      assert.equal(outcome.body.trade.quantity, "24");
      assert.equal(outcome.body.trade.leverage, 5);
      assert.deepEqual(setupSides, filled ? [] : ["long", "short"]);
      assert.equal(outcome.body.trade.sizing.riskAmount, "1.0249298284");
      assert.ok(new D(outcome.body.trade.sizing.estimatedRiskAmount).lte("1.0249298284"));
      assert.ok(calls.indexOf("/api/v3/account/set-leverage") < calls.indexOf("/api/v3/trade/place-order"));
      assert.equal((await ExchangeConnection.findById(connection._id))?.executionLockToken, null);
      const duplicate = await executeTrade(userId, payload, true);
      assert.equal(duplicate.status, 409); assert.equal(submissions, 1);
    } finally {
      getMock.mock.restore(); requestMock.mock.restore();
    }
  }
});

test("testing an existing Bitget connection prepares every supported pair and saves readiness", async t => {
  const userId = new mongoose.Types.ObjectId();
  const encrypted = encryptCredentials("bitget", { apiKey: "test-key", apiSecret: "test-secret", passphrase: "test-passphrase" });
  const connection = await ExchangeConnection.create({ userId, exchange: "bitget", encryptedApiKey: encrypted.apiKey, encryptedApiSecret: encrypted.apiSecret, encryptedPassphrase: encrypted.passphrase });
  const configured = new Set<string>();
  let writes = 0;
  const settings = () => ({ accountMode: "unified", accountLevel: "basic", holdMode: "one_way_mode", deltaSwitch: "no", symbolConfigList: [...configured].map(symbol => ({ category: "USDT-FUTURES", symbol, marginMode: "isolated", leverage: "1" })) });
  t.mock.method(http, "get", async (url: string) => ({ data: { code: "00000", data:
    url.endsWith("/info") ? { userId: "123", permType: "read_and_write", permissions: ["uta_mgt", "uta_trade"] }
      : url.endsWith("/settings") ? settings() : { assets: [] } } }));
  t.mock.method(http, "request", async (options: any) => {
    const url = new URL(options.url), path = url.pathname;
    const body = options.data ? JSON.parse(options.data) : {};
    if (options.method === "POST") {
      assert.equal(path, "/api/v3/account/set-leverage");
      assert.ok((await ExchangeConnection.findById(connection._id))?.executionLockToken);
      configured.add(body.symbol); writes++;
      return { data: { code: "00000", data: "success" } };
    }
    const data = path.endsWith("/settings") ? settings()
      : path.endsWith("/instruments") ? [{ category: "USDT-FUTURES", symbol: url.searchParams.get("symbol"), status: "online", type: "perpetual", quoteCoin: "USDT", minLeverage: "1" }]
        : path.endsWith("/current-position") ? { list: null } : path.endsWith("/unfilled-orders") ? { list: [] } : [];
    return { data: { code: "00000", data } };
  });
  let status = 0, body: any;
  const response = { status(value: number) { status = value; return this; }, json(value: any) { body = value; return this; } };
  await testConnection({ user: userId, params: { connectionId: String(connection._id) } } as any, response as any);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(writes, 20);
  assert.equal(body.accountInfo.isolatedMarginSetup.pairs.length, 10);
  assert.ok(body.accountInfo.isolatedMarginSetup.pairs.every((pair: any) => pair.status === "configured"));
  const stored = await ExchangeConnection.findById(connection._id);
  assert.equal(stored?.executionLockToken, null);
  assert.equal((stored?.accountInfo as any).isolatedMarginSetup.pairs.length, 10);
  await testConnection({ user: userId, params: { connectionId: String(connection._id) } } as any, response as any);
  assert.equal(status, 200);
  assert.equal(writes, 20);
  assert.ok(body.accountInfo.isolatedMarginSetup.pairs.every((pair: any) => pair.status === "ready"));
});
test("frontend balance is ignored, leverage precedes submission, protection precedes success, snapshot persists", async () => {
  for (const balance of [undefined, -1, "tampered", 1_000_000_000]) {
    const f = await fixture();
    const result = await executeTrade(f.userId, { ...f.body, balance }, true, f.dependencies);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(f.entries(), 1); assert.equal(f.checks(), 1);
    assert.equal(result.body.trade.sizing.availableBalance, "50");
    assert.equal(result.body.trade.sizing.riskAmount, "1");
    assert.ok(new D(result.body.trade.sizing.estimatedRiskAmount).lte(1));
    const trade = await Trade.findById(result.body.trade._id).lean();
    assert.equal(trade?.protectionStatus, "confirmed");
    assert.equal(trade?.sizing.orderQuantity, f.submitted().sizing.orderQuantity);
    assert.equal((await ExchangeConnection.findById(f.connection._id))?.executionLockToken, null);
    assert.equal((await executeTrade(f.userId, f.body, true, f.dependencies)).status, 409);
    assert.equal(f.entries(), 1);
  }
});
test("copier quantity uses its own live balance and stop distance, not the pro position or submitted amount", async () => {
  const pro = await fixture("1000");
  const source = await executeTrade(pro.userId, pro.body, true, pro.dependencies);
  const quantities: string[] = [];
  for (const balance of ["50", "100"]) {
    const copier = await fixture(balance);
    const result = await executeTrade(copier.userId, { sourceTradeId: source.body.trade._id, exchangeConnectionId: String(copier.connection._id), balance: 1000 }, false, copier.dependencies);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.trade.sizing.availableBalance, balance);
    assert.ok(new D(result.body.trade.quantity).lt(source.body.trade.quantity));
    quantities.push(result.body.trade.quantity);
  }
  assert.ok(new D(quantities[1]!).gt(quantities[0]!));
});

test("preview ignores submitted balances, uses the copier's exchange balance and matches execution without mutations", async () => {
  const pro = await fixture("1000");
  const source = await executeTrade(pro.userId, pro.body, true, pro.dependencies);
  assert.equal(source.status, 201);
  for (const balance of ["50", "100"]) {
    const copier = await fixture(balance);
    let configurations = 0;
    const configure = copier.dependencies.configureLeverage!;
    copier.dependencies.configureLeverage = async (...args) => { configurations++; await configure(...args); };
    const body = { sourceTradeId: source.body.trade._id, exchangeConnectionId: String(copier.connection._id) };
    let preview: any;
    for (const submitted of [undefined, -1, "tampered", 1e12]) {
      let status = 0, response: any;
      const res = { status(code: number) { status = code; return this; }, json(value: any) { response = value; return this; } };
      await previewTradeWithDependencies({ user: copier.userId, body: { ...body, balance: submitted } } as any, res as any, copier.dependencies);
      assert.equal(status, 200, JSON.stringify(response));
      assert.equal(response.preview.balance, balance);
      assert.equal(response.preview.riskAmount, new D(balance).mul("0.02").toFixed());
      assert.ok(new D(response.preview.estimatedLossIfSL).lte(response.preview.riskAmount));
      if (preview) assert.deepEqual(response.preview.sizing, preview.sizing);
      preview = response.preview;
    }
    assert.equal(configurations, 0);
    assert.equal(copier.entries(), 0);
    assert.equal(copier.checks(), 0);
    assert.equal(await Trade.countDocuments({ userId: copier.userId }), 0);
    const executed = await executeTrade(copier.userId, body, false, copier.dependencies);
    assert.equal(executed.status, 201, JSON.stringify(executed.body));
    const { riskPercent, availableBalanceAtSubmission, ...sizing } = executed.body.trade.sizing;
    const { riskPercent: previewPercent, ...previewSizing } = preview.sizing;
    assert.deepEqual(sizing, previewSizing);
    assert.equal(configurations, 1);
  }
});

test("preview rejects failed exchange data and unsafe or unsupported plans without placing orders", async () => {
  const pro = await fixture("1000");
  const source = await executeTrade(pro.userId, pro.body, true, pro.dependencies);
  for (const scenario of ["api", "cross", "minimum", "unsafe", "deviation"] as const) {
    const f = await fixture();
    const original = f.dependencies.getFuturesContext!;
    if (scenario === "api") f.dependencies.getFuturesContext = async () => { throw new Error("API unavailable: sensitive upstream detail"); };
    if (scenario === "cross") f.dependencies.getFuturesContext = async (...args) => ({ ...await original(...args), marginMode: "cross" });
    if (scenario === "minimum") f.dependencies.getFuturesContext = async (...args) => { const c = await original(...args); return { ...c, rules: { ...c.rules, minimumQuantity: "1" } }; };
    if (scenario === "unsafe") f.dependencies.getFuturesContext = async (...args) => { const c = await original(...args); return { ...c, rules: { ...c.rules, minimumLeverage: "100", tiers: [{ ...c.rules.tiers[0]!, maintenanceRate: "0.009" }] } }; };
    if (scenario === "deviation") f.dependencies.getCurrentPrice = async () => ({ price: "100", raw: {} });
    let status = 0, response: any;
    const res = { status(code: number) { status = code; return this; }, json(value: any) { response = value; return this; } };
    await previewTradeWithDependencies({ user: f.userId, body: { sourceTradeId: source.body.trade._id, exchangeConnectionId: String(f.connection._id) } } as any, res as any, f.dependencies);
    assert.equal(status, scenario === "api" ? 502 : scenario === "deviation" ? 409 : 422);
    assert.equal(response.success, false);
    assert.equal(response.preview, undefined);
    assert.equal(f.entries(), 0);
  }
});
test("leverage refusal, changed available margin and exchange minimum failures submit no entry", async () => {
  const scenarios: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
    f => { f.dependencies.configureLeverage = async () => { throw new TradeRiskError("LEVERAGE_REJECTED", "Leverage refused"); }; },
    f => { f.dependencies.refreshAvailableFuturesBalance = async () => "1"; },
    f => { f.body.sl = "100000"; },
  ];
  for (const scenario of scenarios) {
    const f = await fixture(); scenario(f);
    const result = await executeTrade(f.userId, f.body, true, f.dependencies);
    assert.equal(result.status, 422, JSON.stringify(result.body));
    assert.equal(f.entries(), 0);
    assert.equal(await Trade.countDocuments({ userId: f.userId }), 0);
  }
});
test("protection failure is persisted and never returned as a successful opened trade", async () => {
  const f = await fixture();
  const failure = new ProtectionFailure("entry", "cancelled");
  failure.diagnostics = [{ stage: "repair", code: "EXCHANGE_REJECTED", message: "BITGET rejected the request (code 43011)." }];
  f.dependencies.verifyOrRecoverProtection = async () => { throw failure; };
  const result = await executeTrade(f.userId, f.body, true, f.dependencies);
  assert.equal(result.status, 502); assert.equal(result.body.success, false);
  const trade = await Trade.findById(result.body.tradeId).lean();
  assert.equal(trade?.status, "cancelled"); assert.equal(trade?.protectionStatus, "failed");
  assert.deepEqual(trade?.protectionDiagnostics, failure.diagnostics);
  assert.deepEqual(result.body.protectionDiagnostics, failure.diagnostics);
});
test("monitoring preserves safe lookup diagnostics and reconfirms a protected pending entry after recovery", async t => {
  const f = await fixture();
  const result = await executeTrade(f.userId, f.body, true, f.dependencies);
  assert.equal(result.status, 201);
  const stored = await Trade.findById(result.body.trade._id).lean();
  assert.ok(stored);
  let unavailable = true;
  let writes = 0;
  t.mock.method(http, "get", async () => ({ data: { retCode: 0, time: Date.now() } }));
  t.mock.method(http, "request", async (config: any) => {
    if (config.method !== "GET") { writes++; assert.fail("Protection read-back must not write to the exchange"); }
    const path = new URL(config.url).pathname;
    if (unavailable) throw new Error("signed-url?apiKey=secret&signature=secret");
    if (path === "/v5/position/list") return { data: { retCode: 0, result: { list: [] } } };
    assert.equal(path, "/v5/order/realtime");
    return { data: { retCode: 0, result: { list: [{ orderId: stored.exchangeOrderId,
      orderStatus: "New", cumExecQty: "0", qty: stored.sizing.orderQuantity, price: stored.entryPrice,
      stopLoss: stored.sl, takeProfit: stored.tp, tpslMode: "Full", slLimitPrice: "", slTriggerBy: "MarkPrice" }] } } };
  });
  assert.equal(await enforceStoredTradeProtection(String(stored._id)), false);
  const review = await Trade.findById(stored._id).lean();
  assert.equal(review?.status, "pending");
  assert.equal(review?.protectionStatus, "review");
  assert.deepEqual(review?.protectionDiagnostics, [{ stage: "entry_lookup", code: "EXCHANGE_UNAVAILABLE" }]);
  assert.ok(review?.protectionCheckedAt);
  assert.doesNotMatch(JSON.stringify(review?.protectionDiagnostics), /secret|signature|apiKey/);
  unavailable = false;
  assert.equal(await enforceStoredTradeProtection(String(stored._id)), true);
  const recovered = await Trade.findById(stored._id).lean();
  assert.equal(recovered?.status, "pending");
  assert.equal(recovered?.protectionStatus, "confirmed");
  assert.equal(recovered?.protectionDiagnostics, null);
  assert.equal(writes, 0);
});

test("a protection failure discovered by initial monitoring overrides the earlier pending confirmation", async () => {
  const f = await fixture();
  f.dependencies.startMonitoring = async id => {
    await Trade.updateOne({ _id: id }, { $set: { status: "cancelled", protectionStatus: "failed", protectionError: "Native stop was rejected after entry acknowledgement." } });
  };
  const result = await executeTrade(f.userId, f.body, true, f.dependencies);
  assert.equal(result.status, 502); assert.equal(result.body.code, "STOP_LOSS_PROTECTION_FAILED");
});
test("lost POST response keeps the saved client ID for reconciliation without resubmitting", async () => {
  const f = await fixture();
  f.dependencies.placeOrder = async () => { throw new Error("Response lost"); };
  const result = await executeTrade(f.userId, f.body, true, f.dependencies);
  assert.equal(result.body.code, "ORDER_REVIEW_REQUIRED");
  assert.ok(result.body.clientOrderId);
  assert.equal((await Trade.findById(result.body.tradeId))?.protectionStatus, "review");
  assert.equal((await executeTrade(f.userId, f.body, true, f.dependencies)).status, 409);
});

test("manual close recovers a lost entry response by client ID and cancels the confirmed order", async t => {
  const f = await fixture();
  f.dependencies.placeOrder = async () => { throw new Error("Response lost"); };
  const result = await executeTrade(f.userId, f.body, true, f.dependencies);
  const clientId = result.body.clientOrderId;
  let cancelled = false;
  const mutations: string[] = [];
  t.mock.method(http, "get", async () => ({ data: { retCode: 0, time: Date.now() } }));
  t.mock.method(http, "request", async (config: any) => {
    const url = new URL(config.url);
    if (config.method === "POST") {
      mutations.push(url.pathname);
      assert.equal(url.pathname, "/v5/order/cancel");
      assert.equal(JSON.parse(config.data).orderId, "recovered-entry");
      cancelled = true;
      return { data: { retCode: 0, result: {} } };
    }
    if (url.pathname === "/v5/position/list") return { data: { retCode: 0, result: { list: [] } } };
    assert.equal(url.pathname, "/v5/order/realtime");
    assert.equal(url.searchParams.get("orderId") || url.searchParams.get("orderLinkId"), url.searchParams.has("orderId") ? "recovered-entry" : clientId);
    return { data: { retCode: 0, result: { list: [{ orderId: "recovered-entry", orderLinkId: clientId, orderStatus: cancelled ? "Cancelled" : "New", cumExecQty: "0", qty: "1" }] } } };
  });
  let status = 0, body: any;
  const res = { status(value: number) { status = value; return this; }, json(value: any) { body = value; return this; } };
  await closeProTrade({ params: { tradeId: result.body.tradeId }, user: f.userId, headers: {} } as any, res as any);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.trade.status, "cancelled");
  assert.equal(body.trade.exchangeOrderId, "recovered-entry");
  assert.deepEqual(mutations, ["/v5/order/cancel"]);
});

test("manual close leaves an unconfirmed entry active for review without submitting an order", async t => {
  const f = await fixture();
  f.dependencies.placeOrder = async () => { throw new Error("Response lost"); };
  const result = await executeTrade(f.userId, f.body, true, f.dependencies);
  t.mock.method(http, "get", async () => ({ data: { retCode: 0, time: Date.now() } }));
  t.mock.method(http, "request", async (config: any) => {
    assert.equal(config.method, "GET");
    return { data: { retCode: 0, result: { list: [] } } };
  });
  let status = 0, body: any;
  const res = { status(value: number) { status = value; return this; }, json(value: any) { body = value; return this; } };
  await closeProTrade({ params: { tradeId: result.body.tradeId }, user: f.userId, headers: {} } as any, res as any);
  assert.equal(status, 409);
  assert.equal(body.code, "ORDER_REVIEW_REQUIRED");
  const stored = await Trade.findById(result.body.tradeId);
  assert.equal(stored?.status, "pending");
  assert.equal(stored?.protectionStatus, "review");
  assert.equal(stored?.exchangeOrderId, null);
});
test("testnet rebasing preserves stop distance ratio and still uses the account balance", async () => {
  const previous = process.env.EXCHANGE_MODE;
  try {
    process.env.EXCHANGE_MODE = "testnet";
    const f = await fixture("100");
    f.dependencies.getCurrentPrice = async () => ({ price: "129510.2", raw: {} });
    const result = await executeTrade(f.userId, f.body, true, f.dependencies);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.trade.entryPrice, "129510.2");
    assert.equal(result.body.trade.sl, "129898.6");
    assert.ok(new D(result.body.trade.sizing.estimatedRiskAmount).lte(2));
  } finally { process.env.EXCHANGE_MODE = previous; }
});
