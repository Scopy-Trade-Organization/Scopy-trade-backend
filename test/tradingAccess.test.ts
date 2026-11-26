import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import type { AddressInfo } from "node:net";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import User from "../src/models/userModel.js";
import { Trade } from "../src/models/tradeModel.js";
import { CopySubscription, CopyExecution, CopyExecutionLock } from "../src/models/copySubscriptionModel.js";
import { ExchangeConnection } from "../src/models/exchangeConnectionModel.js";
import proRouter from "../src/routes/proTraderDashboardRoutes.js";
import copyRouter from "../src/routes/copyTraderDashboardRoutes.js";
import { signAccessToken } from "../src/helpers/jwtHelper.js";
import { drainCopyQueue, enqueueAutomaticCopies } from "../src/services/automaticCopyService.js";
import { getProfitShareSummary } from "../src/services/profitSharingService.js";

let database: MongoMemoryReplSet;
let server: ReturnType<express.Express["listen"]>;
let baseUrl: string;
const originalSecret = process.env.JWT_SECRET, originalExpiry = process.env.JWT_EXPIRES_IN;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 60_000 }] });
  await mongoose.connect(database.getUri());
  await Promise.all([User.init(), CopySubscription.init(), CopyExecution.init(), CopyExecutionLock.init()]);
  process.env.JWT_SECRET = "trading-access-tests-only-32-character-secret";
  process.env.JWT_EXPIRES_IN = "15m";
  const app = express();
  app.use(express.json(), cookieParser());
  app.use("/pro", proRouter);
  app.use("/copy", copyRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  if (server) await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  await mongoose.disconnect();
  await database?.stop();
  if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
  if (originalExpiry === undefined) delete process.env.JWT_EXPIRES_IN; else process.env.JWT_EXPIRES_IN = originalExpiry;
});
async function user(role: "ProTrader" | "CopyTrader", status?: string) {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id, email: `${_id}@example.com`, firstName: "Test", lastName: "Trader", traderID: String(_id), role, ...(status ? { status } : {}), sessionVersion: 0, settlementOwedUnits: 0 });
  return { _id, cookie: `user_token=${signAccessToken(String(_id), "user", 0)}` };
}
function request(path: string, cookie: string, method = "POST") {
  return fetch(baseUrl + path, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ status: "live" }) } : {}) });
}

test("only pro trade creation is temporarily restricted; copying and management stay accessible", async () => {
  for (const status of ["active", "waitlist", "suspended", undefined]) {
    const pro = await user("ProTrader", status), copier = await user("CopyTrader", status);
    const response = await request("/pro/trades", pro.cookie);
    assert.equal(response.status, 403, `pro creation: ${status}`);
    assert.equal((await response.json()).message, "Live trading is coming soon.");
    assert.equal((await request("/copy/traders/invalid/copy", copier.cookie)).status, 400);
    assert.equal((await request("/pro/trades", pro.cookie, "GET")).status, 200);
    assert.equal((await request(`/copy/traders/${pro._id}/copy`, copier.cookie, "DELETE")).status, 200);
    // A missing trade returns 404, demonstrating management is not blocked by status.
    assert.equal((await request(`/pro/trades/${new mongoose.Types.ObjectId()}/close`, pro.cookie)).status, 404);
  }
});

test("live users pass access checks and a database downgrade takes effect with the same session", async () => {
  const pro = await user("ProTrader", "live"), copier = await user("CopyTrader", "live");
  assert.equal((await request("/pro/trades", pro.cookie)).status, 400);
  assert.equal((await request("/copy/traders/invalid/copy", copier.cookie)).status, 400);
  await User.updateMany({ _id: { $in: [pro._id, copier._id] } }, { $set: { status: "active" } });
  assert.equal((await request("/pro/trades", pro.cookie)).status, 403);
  assert.equal((await request("/copy/traders/invalid/copy", copier.cookie)).status, 400);
});

test("active copy traders can discover active and live pro traders", async () => {
  const pro = await user("ProTrader", "live"), activePro = await user("ProTrader", "active"), copier = await user("CopyTrader", "active");
  const discovery = await request("/copy/traders", copier.cookie, "GET");
  assert.equal(discovery.status, 200);
  const traders = (await discovery.json()).traders as { _id: string }[];
  assert.ok(traders.some(trader => trader._id === String(pro._id)));
  assert.ok(traders.some(trader => trader._id === String(activePro._id)));
  assert.equal((await request(`/copy/traders/${pro._id}`, copier.cookie, "GET")).status, 200);
});

test("legacy accounts can subscribe without allocation and restart the same subscription", async () => {
  const pro = await user("ProTrader", "active"), copier = await user("CopyTrader", "active");
  await User.collection.updateOne({ _id: copier._id }, { $unset: { settlementOwedUnits: 1 } });
  const connection = await ExchangeConnection.create({ userId: copier._id, exchange: "bybit" });
  const subscribe = (body: unknown = { exchangeConnectionId: connection._id }) => fetch(`${baseUrl}/copy/traders/${pro._id}/copy`, {
    method: "POST", headers: { Cookie: copier.cookie, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const response = await subscribe();
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  assert.equal(result.subscription.allocation, undefined);
  assert.equal((await User.findById(copier._id).lean())?.settlementOwedUnits, undefined);
  assert.equal((await getProfitShareSummary(copier._id)).pendingAmount, "0.000000");
  assert.equal((await subscribe()).status, 409);
  assert.equal((await request(`/copy/traders/${pro._id}/copy`, copier.cookie, "DELETE")).status, 200);
  // An older client may still submit allocation; it has no effect on copying.
  const restarted = await subscribe({ exchangeConnectionId: connection._id, allocation: 1e12 });
  assert.equal(restarted.status, 201);
  assert.equal((await restarted.json()).subscription._id, result.subscription._id);
  assert.equal(await CopySubscription.countDocuments({ copierId: copier._id, proTraderId: pro._id }), 1);
});

test("subscription validates the account and concurrent requests cannot create duplicates", async () => {
  const pro = await user("ProTrader", "active"), copier = await user("CopyTrader", "active");
  const other = await user("CopyTrader", "active");
  const connection = await ExchangeConnection.create({ userId: copier._id, exchange: "bybit" });
  const otherConnection = await ExchangeConnection.create({ userId: other._id, exchange: "bybit" });
  const subscribe = (body?: unknown) => fetch(`${baseUrl}/copy/traders/${pro._id}/copy`, {
    method: "POST", headers: { Cookie: copier.cookie, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await subscribe()).status, 400);
  assert.equal((await subscribe({ exchangeConnectionId: otherConnection._id })).status, 422);
  await ExchangeConnection.updateOne({ _id: connection._id }, { $set: { isActive: false } });
  assert.equal((await subscribe({ exchangeConnectionId: connection._id })).status, 422);
  await ExchangeConnection.updateOne({ _id: connection._id }, { $set: { isActive: true } });
  const responses = await Promise.all([subscribe({ exchangeConnectionId: connection._id }), subscribe({ exchangeConnectionId: connection._id })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.equal(await CopySubscription.countDocuments({ copierId: copier._id, proTraderId: pro._id }), 1);
});

test("settlement debt permits subscriptions while remaining due for trade execution", async () => {
  const pro = await user("ProTrader", "active"), copier = await user("CopyTrader", "active");
  await User.collection.updateOne({ _id: copier._id }, { $unset: { settlementOwedUnits: 1 } });
  await Trade.collection.insertMany(["pending", "processing", "failed", "collected", "waived"].map(feeStatus => ({
    userId: copier._id, tradeOrigin: "copy", tradeResult: "profit", feeStatus, platformFee: "4.000000",
    signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId(),
  })));
  const summaries = await Promise.all([getProfitShareSummary(copier._id), getProfitShareSummary(copier._id)]);
  for (const summary of summaries) {
    assert.equal(summary.pendingAmount, "12.000000");
    assert.equal(summary.settlementRequired, true);
  }
  assert.equal((await User.findById(copier._id).lean())?.settlementOwedUnits, 12_000_000);
  const connection = await ExchangeConnection.create({ userId: copier._id, exchange: "bybit", balanceUsdt: 0 });
  const response = await fetch(`${baseUrl}/copy/traders/${pro._id}/copy`, {
    method: "POST", headers: { Cookie: copier.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ exchangeConnectionId: connection._id }),
  });
  assert.equal(response.status, 201);
  assert.equal(await CopySubscription.countDocuments({ copierId: copier._id }), 1);
  const sourceId = new mongoose.Types.ObjectId();
  await Trade.collection.insertOne({ _id: sourceId, userId: pro._id, signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId(), tradeOrigin: "pro", status: "filled", protectionStatus: "confirmed", pair: "BTCUSDT", createdAt: new Date(Date.now() + 1000) });
  await enqueueAutomaticCopies(String(sourceId));
  let executions = 0;
  await drainCopyQueue({ executeTrade: async () => { executions++; return { status: 201, body: {} }; } });
  assert.equal(executions, 0);
  const job = await CopyExecution.findOne({ sourceTradeId: sourceId, copierId: copier._id }).lean();
  assert.equal(job?.status, "failed");
  assert.match(job?.reason ?? "", /Settle your outstanding profit share/);
  await User.updateOne({ _id: copier._id }, { $set: { settlementOwedUnits: 99_000_000 } });
  assert.equal((await getProfitShareSummary(copier._id)).pendingAmount, "99.000000");
  await User.collection.updateOne({ _id: copier._id }, { $set: { settlementOwedUnits: -1 } });
  await assert.rejects(getProfitShareSummary(copier._id), /Settlement balance unavailable/);
});

test("automatic copying accepts active and live accounts using normal account availability", async () => {
  for (const [copierStatus, proStatus] of [["live", "live"], ["active", "live"], ["active", "active"], ["waitlist", "live"], ["suspended", "live"], ["live", "active"], ["live", "suspended"]]) {
    const copier = await user("CopyTrader", "live"), pro = await user("ProTrader", "live");
    const sourceId = new mongoose.Types.ObjectId(), connectionId = new mongoose.Types.ObjectId();
    const subscription = await CopySubscription.create({ copierId: copier._id, proTraderId: pro._id, exchangeConnectionId: connectionId, startedAt: new Date(Date.now() - 5000) });
    await Trade.collection.insertOne({ _id: sourceId, userId: pro._id, signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId(), status: "filled", protectionStatus: "confirmed", createdAt: new Date(), pair: "BTCUSDT", tradeOrigin: "pro" });
    await enqueueAutomaticCopies(String(sourceId));
    await User.updateOne({ _id: copier._id }, { $set: { status: copierStatus } });
    await User.updateOne({ _id: pro._id }, { $set: { status: proStatus } });
    let executions = 0;
    await drainCopyQueue({ executeTrade: async () => { executions++; return { status: 201, body: {} }; } });
    const allowed = ["active", "live"].includes(copierStatus!) && ["active", "live"].includes(proStatus!);
    assert.equal(executions, allowed ? 1 : 0);
    const job = await CopyExecution.findOne({ subscriptionId: subscription._id }).lean();
    assert.equal(job?.status, allowed ? "completed" : "failed");
  }
});
