import axios from "axios";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { executeTrade, type ExecutionDependencies } from "../src/services/tradeExecutionService.js";
import { ExchangeConnection } from "../src/models/exchangeConnectionModel.js";
import { Trade } from "../src/models/tradeModel.js";
import User from "../src/models/userModel.js";
import { encryptCredentials } from "../src/services/exchangeConnectionService.js";
import { D, TradeRiskError, type InstrumentRules } from "../src/services/tradeRiskService.js";
import { ProtectionFailure } from "../src/services/tradeProtectionService.js";
import { previewTradeWithDependencies } from "../src/controllers/tradeController.js";

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
  f.dependencies.verifyOrRecoverProtection = async () => { throw new ProtectionFailure("entry", "cancelled"); };
  const result = await executeTrade(f.userId, f.body, true, f.dependencies);
  assert.equal(result.status, 502); assert.equal(result.body.success, false);
  const trade = await Trade.findById(result.body.tradeId).lean();
  assert.equal(trade?.status, "cancelled"); assert.equal(trade?.protectionStatus, "failed");
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
