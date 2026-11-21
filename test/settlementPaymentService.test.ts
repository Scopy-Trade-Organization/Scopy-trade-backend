import { Earning } from "../src/models/earningModel.js";
import { drainCopyQueue } from "../src/services/automaticCopyService.js";
import { CopyExecution, CopySubscription, CopyExecutionLock, CopyNotification } from "../src/models/copySubscriptionModel.js";
import { executeTrade } from "../src/services/tradeExecutionService.js";
import { getFinanceSummary, withdrawFunds, withdrawalOtpContext } from "../src/controllers/proFinanceController.js";
import { quoteWithdrawalFee, networkFeeUnits, assertWithdrawalSize } from "../src/services/withdrawalFeeService.js";
import { adjustProBalance } from "../src/services/proBalanceService.js";
import { issueOtp } from "../src/services/otpService.js";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import axios from "axios";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { TronWeb } from "tronweb";
import { ensureSettlement, validateSettlementReceipt, verifySettlement, scanSettlementInvoice, normalizeSettlementHash, runSettlementWorker, retrySettlementForUser, deliverSettlementEmails } from "../src/services/settlementPaymentService.js";
import { MAINNET_USDT, TRANSFER_TOPIC, finishWithdrawal, reconcileProWithdrawal, processProWithdrawal } from "../src/services/proFinanceService.js";
import { Transaction } from "../src/models/transactionModel.js";
import { Notification } from "../src/models/notificationModel.js";
import { Trade } from "../src/models/tradeModel.js";
import User from "../src/models/userModel.js";
import { processTradeClose, getProfitShareSummary } from "../src/services/profitSharingService.js";

const wallet = TronWeb.address.fromPrivateKey("1".padStart(64, "0")) as string;
const senderKey = "2".padStart(64, "0");
const sender = TronWeb.address.fromPrivateKey(senderKey) as string;
const hash = "a".repeat(64);
const topic = (address: string) => TronWeb.address.toHex(address).slice(2).toLowerCase().padStart(64, "0");
function receipt(invoice: any, memo: string | null = invoice.memo) {
  return {
    tx: { txID: hash, raw_data: { ...(memo === null ? {} : { data: Buffer.from(memo).toString("hex") }), contract: [{ type: "TriggerSmartContract", parameter: { value: {
      owner_address: TronWeb.address.toHex(sender), contract_address: TronWeb.address.toHex(MAINNET_USDT),
      data: "a9059cbb" + topic(invoice.address) + BigInt(invoice.units).toString(16).padStart(64, "0"),
    } } }] } },
    info: { id: hash, blockNumber: 123, blockTimeStamp: Date.now() + 1000, receipt: { result: "SUCCESS" }, log: [{
      address: TronWeb.address.toHex(MAINNET_USDT).slice(2), topics: [TRANSFER_TOPIC, topic(sender), topic(invoice.address)], data: BigInt(invoice.units).toString(16).padStart(64, "0"),
    }] },
  };
}
const sample = { _id: new mongoose.Types.ObjectId(), units: 12_000_000, memo: "SCOPY-test", address: wallet, createdAt: new Date() };

test("only successful exact mainnet USDT payments with the invoice memo pass", () => {
  const { tx, info } = receipt(sample);
  assert.equal(validateSettlementReceipt(sample, hash, tx, info), sender);
  assert.throws(() => validateSettlementReceipt(sample, hash, tx, { ...info, receipt: { result: "REVERT" } }));
  assert.throws(() => validateSettlementReceipt(sample, hash, tx, { ...info, blockTimeStamp: 1 }));
  assert.throws(() => validateSettlementReceipt({ ...sample, units: 13_000_000 }, hash, tx, info));
  assert.throws(() => validateSettlementReceipt(sample, hash, tx, { ...info, log: [] }));
  const wrongMemo = receipt(sample, "SCOPY-another-invoice");
  assert.throws(() => validateSettlementReceipt(sample, hash, wrongMemo.tx, wrongMemo.info));
  const wrongContract = structuredClone(tx);
  wrongContract.raw_data.contract[0]!.parameter.value.contract_address = TronWeb.address.toHex(sender);
  assert.throws(() => validateSettlementReceipt(sample, hash, wrongContract, info));
});

test("hash fallback accepts memo-less payments without wallet signatures", () => {
  const { tx, info } = receipt(sample, null);
  assert.equal(validateSettlementReceipt(sample, hash, tx, info), sender);
  assert.equal(normalizeSettlementHash(` 0x${hash.toUpperCase()} `), hash);
});

let replica: MongoMemoryReplSet;
before(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 60_000 }] });
  await mongoose.connect(replica.getUri());
  await Promise.all([Transaction.init(), Notification.init(), Earning.init(), CopyExecution.init(), CopyExecutionLock.init(), CopyNotification.init()]);
  process.env.SYSTEM_WALLET_ADDRESS = wallet;
}, { timeout: 180_000 });
after(async () => { await mongoose.disconnect(); await replica?.stop(); });

test("invoice creation, notification, chain completion and earnings are idempotent", async () => {
  const copierId = new mongoose.Types.ObjectId(), proId = new mongoose.Types.ObjectId();
  const sourceId = new mongoose.Types.ObjectId(), tradeId = new mongoose.Types.ObjectId();
  await User.collection.insertMany([{ _id: copierId, email: "copier@example.com", traderID: "copy-test", role: "CopyTrader", settlementOwedUnits: 12_000_000 }, { _id: proId, email: "pro@example.com", traderID: "pro-test", proBalanceUnits: 0 }]);
  await Trade.collection.insertMany([{ _id: sourceId, tradeOrigin: "pro", userId: proId, signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId() }, {
    _id: tradeId, userId: copierId, sourceTradeId: sourceId, signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId(), tradeOrigin: "copy", tradeResult: "profit", status: "closed",
    platformFee: "12.000000", proTraderShare: "6.000000", feeStatus: "pending", proTraderCreditStatus: "pending",
  }]);
  const invoices = await Promise.all([ensureSettlement(copierId), ensureSettlement(copierId)]);
  const invoice = invoices[0]!;
  assert.equal(String(invoice._id), String(invoices[1]!._id));
  assert.equal(await Notification.countDocuments({ userId: copierId, kind: "settlement_due" }), 1);
  assert.equal((await Trade.findById(tradeId).lean())?.feeStatus, "processing");
  // Fees accruing after invoice creation must remain owed after this invoice is paid.
  await User.updateOne({ _id: copierId }, { $inc: { settlementOwedUnits: 2_000_000 } });
  const { tx, info } = receipt(invoice);
  const factory = (() => ({ post: async (path: string) => ({ data: path.endsWith("gettransactionbyid") ? tx : info }) })) as any;
  await verifySettlement(copierId, String(invoice._id), hash, factory);
  await verifySettlement(copierId, String(invoice._id), hash, factory);
  assert.equal((await Transaction.findOne({ type: "settlement", _id: invoice._id }).lean())?.status, "COMPLETED");
  assert.equal((await Trade.findById(tradeId).lean())?.feeStatus, "collected");
  assert.equal((await User.findById(copierId).lean())?.settlementOwedUnits, 2_000_000);
  assert.equal((await getProfitShareSummary(copierId)).pendingAmount, "2.000000");
  assert.equal((await User.findById(proId).lean())?.proBalanceUnits, 6_000_000);
  assert.equal(await Earning.countDocuments({ tradeId }), 1);
  assert.equal(await Earning.countDocuments({ userId: proId }), 1);
  assert.equal(await Transaction.countDocuments({ userId: proId, type: "earning" }), 0);
  await assert.rejects(Earning.create({ tradeId, userId: proId, units: 6_000_000, status: "COMPLETED" }), /duplicate key/);
  assert.equal(await Notification.countDocuments({ userId: copierId, kind: "settlement_paid" }), 1);
  await assert.rejects(verifySettlement(new mongoose.Types.ObjectId(), String(invoice._id), hash, factory), /not found/);
  await assert.rejects(Transaction.create({ type: "withdrawal", userId: proId, requestId: "duplicate-hash", status: "QUEUED", units: 1, address: wallet, transactionId: hash }), /duplicate key/);
  assert.equal(await ensureSettlement(copierId), null);
});

test("threshold and fixed invoice protect later trade fees from being marked paid", async () => {
  const userId = new mongoose.Types.ObjectId();
  const id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: userId, email: "threshold@example.com", traderID: "threshold-test", settlementOwedUnits: 9_999_999 });
  await Trade.collection.insertOne({ _id: id, userId, signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId(), tradeOrigin: "copy", tradeResult: "profit", platformFee: "9.999999", feeStatus: "pending" });
  assert.equal(await ensureSettlement(userId), null);
  await Trade.collection.updateOne({ _id: id }, { $set: { platformFee: "10.000000" } });
  await User.updateOne({ _id: userId }, { $inc: { settlementOwedUnits: 1 } });
  const invoice = await ensureSettlement(userId);
  assert.equal(invoice?.units, 10_000_000);
  await Trade.collection.insertOne({ userId, signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId(), tradeOrigin: "copy", tradeResult: "profit", platformFee: "2.000000", feeStatus: "pending" });
  assert.equal((await ensureSettlement(userId))?.units, 10_000_000);
  assert.equal(await Trade.countDocuments({ userId, feeStatus: "pending" }), 1);
});



test("failed withdrawals refund the actual balance only once", async () => {
  const userId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: userId, email: "refund@example.com", traderID: "refund-test", proBalanceUnits: 5_000_000 });
  const withdrawal = await Transaction.create({ userId, type: "withdrawal", units: 3_000_000, address: wallet, status: "QUEUED", requestId: "refund-once" });
  await finishWithdrawal(withdrawal._id, "FAILED", "QUEUED");
  await finishWithdrawal(withdrawal._id, "FAILED", "QUEUED");
  assert.equal((await User.findById(userId).lean())?.proBalanceUnits, 8_000_000);
  assert.equal((await Transaction.findById(withdrawal._id).lean())?.status, "FAILED");
});


test("trade close accrues settlement debt exactly once under concurrent requests", async () => {
  const userId = new mongoose.Types.ObjectId(), id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: userId, email: "close@example.com", traderID: "close-test", settlementOwedUnits: 0 });
  await Trade.collection.insertOne({ _id: id, userId, pair: "BTCUSDT", direction: "buy", quantity: "1", entryPrice: "100", status: "filled", tradeOrigin: "copy", signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId() });
  await Promise.all([processTradeClose(String(id), "120", "tp"), processTradeClose(String(id), "120", "tp")]);
  await processTradeClose(String(id), "120", "tp");
  assert.equal((await User.findById(userId).lean())?.settlementOwedUnits, 4_000_000);
  assert.equal((await getProfitShareSummary(userId)).pendingAmount, "4.000000");
  assert.equal((await Trade.findById(id).lean())?.status, "closed");
  assert.equal((await Trade.findById(id).lean())?.settlementInvoicePending, false);
});

test("a missing balance rolls back the trade close instead of losing the debt", async () => {
  const userId = new mongoose.Types.ObjectId(), id = new mongoose.Types.ObjectId();
  await Trade.collection.insertOne({ _id: id, userId, pair: "BTCUSDT", direction: "buy", quantity: "1", entryPrice: "100", status: "filled", tradeOrigin: "copy", signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId() });
  await assert.rejects(processTradeClose(String(id), "120", "tp"), /balance unavailable/);
  assert.equal((await Trade.findById(id).lean())?.status, "filled");
  assert.notEqual((await Trade.findById(id).lean())?.settlementInvoicePending, true);
});

test("failed invoice creation preserves the closed trade and retries only marked trades after a delay", async (t) => {
  const userId = new mongoose.Types.ObjectId(), id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: userId, email: "retry@example.com", traderID: "retry-test", role: "CopyTrader", settlementOwedUnits: 0 });
  // This legacy user has no balance. A background sweep must never visit it.
  await User.collection.insertOne({ email: "legacy@example.com", traderID: "legacy-test", role: "CopyTrader" });
  await Trade.collection.insertOne({ _id: id, userId, pair: "BTCUSDT", direction: "buy", quantity: "1", entryPrice: "100", status: "filled", tradeOrigin: "copy", signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId() });
  const originalWallet = process.env.SYSTEM_WALLET_ADDRESS;
  t.after(() => { process.env.SYSTEM_WALLET_ADDRESS = originalWallet; });
  process.env.SYSTEM_WALLET_ADDRESS = "invalid";
  await processTradeClose(String(id), "160", "tp");
  assert.equal((await Trade.findById(id).lean())?.status, "closed");
  assert.equal((await User.findById(userId).lean())?.settlementOwedUnits, 12_000_000);
  const failed = (await Trade.findById(id).lean())!;
  assert.equal(failed.settlementInvoicePending, true);
  assert.match(failed.settlementError!, /SYSTEM_WALLET_ADDRESS/);
  assert.ok(failed.settlementInvoiceRetryAt!.getTime() > Date.now());
  await retrySettlementForUser(userId);
  await processTradeClose(String(id), "160", "tp");
  assert.equal((await Trade.findById(id).lean())?.settlementInvoiceRetryAt?.getTime(), failed.settlementInvoiceRetryAt!.getTime());
  process.env.SYSTEM_WALLET_ADDRESS = wallet;
  await Trade.updateOne({ _id: id }, { $set: { settlementInvoiceRetryAt: new Date(0) } });
  const noSweep = t.mock.method(User, "find", () => { throw new Error("Full user scan is forbidden"); });
  await runSettlementWorker();
  noSweep.mock.restore();
  assert.equal((await Trade.findById(id).lean())?.settlementInvoicePending, false);
  assert.equal((await Trade.findById(id).lean())?.settlementError, null);
  assert.equal(await Transaction.countDocuments({ userId, type: "settlement", status: "AWAITING_PAYMENT" }), 1);
  assert.equal(await Notification.countDocuments({ userId, kind: "settlement_due" }), 1);
  assert.equal((await User.findById(userId).lean())?.settlementOwedUnits, 12_000_000);
});

test("retrying an interrupted invoice check preserves a newer trade's pending marker", async (t) => {
  const userId = new mongoose.Types.ObjectId(), id = new mongoose.Types.ObjectId(), newerId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: userId, email: "recovery@example.com", traderID: "recovery-test", settlementOwedUnits: 12_000_000 });
  await Trade.collection.insertOne({ _id: id, userId, signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId(), tradeOrigin: "copy", tradeResult: "profit", platformFee: "12.000000", feeStatus: "pending", settlementInvoicePending: true, settlementInvoiceRetryAt: new Date(0) });
  const updateNotification = Notification.updateOne.bind(Notification);
  const notificationMock = t.mock.method(Notification, "updateOne", async (...args: any[]) => {
    if (args[2]?.upsert) await Trade.collection.insertOne({ _id: newerId, userId, signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId(), tradeOrigin: "copy", tradeResult: "profit", platformFee: "1.000000", feeStatus: "pending", settlementInvoicePending: true, settlementInvoiceRetryAt: new Date() });
    return (updateNotification as any)(...args);
  });
  await retrySettlementForUser(userId);
  notificationMock.mock.restore();
  assert.equal((await Trade.findById(id).lean())?.settlementInvoicePending, false);
  assert.equal((await Trade.findById(newerId).lean())?.settlementInvoicePending, true);
  await runSettlementWorker();
  assert.equal((await Trade.findById(newerId).lean())?.settlementInvoicePending, false);
  assert.equal(await Transaction.countDocuments({ userId, type: "settlement", status: "AWAITING_PAYMENT" }), 1);
});

test("threshold crossing sends email immediately and failed delivery retries without recreating the invoice", async (t) => {
  const envNames = ["GMAIL_SENDER_EMAIL", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"];
  const previous = envNames.map(name => process.env[name]);
  envNames.forEach(name => { process.env[name] = "test-only"; });
  t.after(() => envNames.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name];
    else process.env[name] = previous[i];
  }));
  let attempts = 0, fail = true;
  t.mock.method(axios, "post", async (url: string, body: any) => {
    if (url === "https://oauth2.googleapis.com/token") return { data: { access_token: "test-token", expires_in: 0 } };
    assert.equal(url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    const message = Buffer.from(body.raw, "base64url").toString();
    if (message.includes(Buffer.from("Profit-share settlement due").toString("base64"))) {
      attempts++;
      if (fail) throw new Error("Simulated email outage");
    }
    return { data: {} };
  });
  for (const shouldFail of [true, false]) {
    fail = shouldFail;
    const userId = new mongoose.Types.ObjectId(), id = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: userId, email: `${userId}@example.com`, traderID: String(userId), settlementOwedUnits: 0 });
    await Trade.collection.insertOne({ _id: id, userId, pair: "BTCUSDT", direction: "buy", quantity: "1", entryPrice: "100", status: "filled", tradeOrigin: "copy", signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId() });
    const beforeAttempts = attempts;
    await processTradeClose(String(id), "160", "tp");
    assert.equal(attempts, beforeAttempts + 1);
    const invoice = (await Transaction.findOne({ userId, type: "settlement" }).lean())!;
    const notification = (await Notification.findOne({ settlementId: invoice._id, kind: "settlement_due" }).lean())!;
    assert.equal((await Trade.findById(id).lean())?.settlementInvoicePending, false);
    if (shouldFail) {
      assert.equal(notification.emailSentAt, null);
      assert.ok(notification.emailLastError);
      assert.ok(notification.emailLeaseUntil!.getTime() >= Date.now() + 14 * 60_000);
      await ensureSettlement(userId);
      assert.equal(attempts, beforeAttempts + 1);
      fail = false;
      await Notification.updateOne({ _id: notification._id }, { $set: { emailLeaseUntil: new Date(0) } });
      await deliverSettlementEmails(invoice._id);
    }
    assert.ok((await Notification.findById(notification._id).lean())?.emailSentAt);
    const sentAttempts = attempts;
    await ensureSettlement(userId);
    await deliverSettlementEmails(invoice._id);
    assert.equal(attempts, sentAttempts);
    assert.equal(await Transaction.countDocuments({ userId, type: "settlement" }), 1);
  }
});

let sequence = 100;
async function fixture() {
  const userId = new mongoose.Types.ObjectId(), tradeId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: userId, email: `${userId}@example.com`, traderID: String(userId), role: "CopyTrader", status: "active", settlementOwedUnits: 12_000_000 });
  await Trade.collection.insertOne({ _id: tradeId, userId, signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId(), tradeOrigin: "copy", tradeResult: "profit", platformFee: "12.000000", feeStatus: "pending", proTraderCreditStatus: "waived" });
  const invoice = (await ensureSettlement(userId))!;
  const txHash = (++sequence).toString(16).padStart(64, "0");
  return { userId, tradeId, invoice, txHash };
}
function chain(invoice: any, txHash: string, memo: string | null = invoice.memo) {
  const result = receipt(invoice, memo);
  result.tx.txID = txHash;
  result.info.id = txHash;
  return result;
}
function clientFor(result: ReturnType<typeof receipt>) {
  return (() => ({ post: async (path: string) => ({ data: path.endsWith("gettransactionbyid") ? result.tx : result.info }) })) as any;
}

test("paying a fixed invoice schedules a check for fees accrued after its creation", async () => {
  const { userId, invoice, txHash } = await fixture();
  const laterId = new mongoose.Types.ObjectId();
  await Trade.collection.insertOne({ _id: laterId, userId, signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId(), tradeOrigin: "copy", tradeResult: "profit", platformFee: "10.000000", feeStatus: "pending", settlementInvoicePending: false });
  await User.updateOne({ _id: userId }, { $inc: { settlementOwedUnits: 10_000_000 } });
  await verifySettlement(userId, String(invoice._id), txHash, clientFor(chain(invoice, txHash)));
  assert.equal((await Trade.findById(laterId).lean())?.settlementInvoicePending, true);
  await runSettlementWorker();
  assert.equal((await Transaction.findOne({ userId, type: "settlement", status: "AWAITING_PAYMENT" }).lean())?.units, 10_000_000);
  assert.equal((await Trade.findById(laterId).lean())?.settlementInvoicePending, false);
});

test("two users racing for a memo-less hash: the first claim wins permanently", async () => {
  const first = await fixture(), second = await fixture();
  const result = chain(first.invoice, first.txHash, null);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const slow = (() => ({ post: async (path: string) => {
    calls++; entered(); await gate;
    return { data: path.endsWith("gettransactionbyid") ? result.tx : result.info };
  } })) as any;
  const winner = verifySettlement(first.userId, String(first.invoice._id), first.txHash, slow);
  await ready;
  await assert.rejects(verifySettlement(second.userId, String(second.invoice._id), first.txHash.toUpperCase(), slow), /processed|claimed|used/);
  assert.equal(calls, 2);
  release(); await winner;
  await assert.rejects(verifySettlement(second.userId, String(second.invoice._id), first.txHash, slow), /used/);
  assert.equal((await Transaction.findOne({ transactionHash: first.txHash }))?.status, "CONFIRMED");
  assert.equal((await User.findById(second.userId))?.settlementOwedUnits, 12_000_000);
  assert.equal((await User.findById(first.userId))?.settlementOwedUnits, 0);
  assert.equal((await getProfitShareSummary(first.userId)).settlementRequired, false);
  const record = (await Transaction.findOne({ transactionHash: first.txHash }).lean())!;
  await assert.rejects(Transaction.create({ ...record, _id: new mongoose.Types.ObjectId() }), /duplicate key/);
});

test("simultaneous insert claims are protected by the unique database index", async () => {
  const a = await fixture(), b = await fixture();
  const factory = clientFor(chain(a.invoice, a.txHash, null));
  const outcomes = await Promise.allSettled([
    verifySettlement(a.userId, String(a.invoice._id), a.txHash, factory),
    verifySettlement(b.userId, String(b.invoice._id), a.txHash, factory),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(await Transaction.countDocuments({ transactionId: a.txHash, status: "COMPLETED" }), 1);
});

test("temporary API failure and missing solidified receipts release claims for retry", async () => {
  for (const missing of [false, true]) {
    const f = await fixture();
    const unavailable = (() => ({ post: async () => { if (missing) return { data: {} }; throw new Error("network timeout"); } })) as any;
    await assert.rejects(verifySettlement(f.userId, String(f.invoice._id), f.txHash, unavailable));
    const rejected = await Transaction.findOne({ transactionHash: f.txHash });
    assert.equal(rejected?.status, "REJECTED");
    assert.equal(rejected?.retryable, true);
    await verifySettlement(f.userId, String(f.invoice._id), f.txHash, clientFor(chain(f.invoice, f.txHash)));
    assert.equal((await Transaction.findOne({ transactionHash: f.txHash }))?.status, "CONFIRMED");
  }
});

test("wrong recipient, token, failed transfer, insufficient amount and wrong memo do not credit", async () => {
  for (const kind of ["recipient", "token", "failed", "amount", "memo"]) {
    const f = await fixture();
    const result = chain(f.invoice, f.txHash, kind === "memo" ? "SCOPY-other" : null);
    const value = result.tx.raw_data.contract[0]!.parameter.value;
    if (kind === "recipient") value.data = "a9059cbb" + topic(sender) + BigInt(f.invoice.units).toString(16).padStart(64, "0");
    if (kind === "token") value.contract_address = TronWeb.address.toHex(sender);
    if (kind === "failed") result.info.receipt.result = "REVERT";
    if (kind === "amount") value.data = "a9059cbb" + topic(wallet) + BigInt(f.invoice.units - 1).toString(16).padStart(64, "0");
    await assert.rejects(verifySettlement(f.userId, String(f.invoice._id), f.txHash, clientFor(result)));
    assert.equal((await Transaction.findOne({ transactionHash: f.txHash }))?.status, "REJECTED");
    assert.equal((await Transaction.findById(f.invoice._id))?.status, "AWAITING_PAYMENT");
    assert.equal((await User.findById(f.userId))?.settlementOwedUnits, f.invoice.units);
    assert.equal((await Trade.findById(f.tradeId))?.feeStatus, "processing");
  }
});

test("balance or invoice fee mismatch rolls back the whole confirmation", async () => {
  for (const corrupt of ["balance", "owner", "amount"]) {
    const f = await fixture();
    if (corrupt === "balance") await User.updateOne({ _id: f.userId }, { $set: { settlementOwedUnits: 0 } });
    if (corrupt === "owner") await Trade.updateOne({ _id: f.tradeId }, { $set: { userId: new mongoose.Types.ObjectId() } });
    if (corrupt === "amount") await Trade.updateOne({ _id: f.tradeId }, { $set: { platformFee: "11.000000" } });
    await assert.rejects(verifySettlement(f.userId, String(f.invoice._id), f.txHash, clientFor(chain(f.invoice, f.txHash))), /balance|reconcile/);
    assert.equal((await Transaction.findById(f.invoice._id))?.status, "AWAITING_PAYMENT");
    assert.equal((await Trade.findById(f.tradeId))?.feeStatus, "processing");
    assert.equal(await Notification.countDocuments({ settlementId: f.invoice._id, kind: "settlement_paid" }), 0);
    assert.equal(await Transaction.countDocuments({ transactionHash: f.txHash, status: "CONFIRMED" }), 0);
    assert.equal((await getProfitShareSummary(f.userId)).settlementRequired, true);
  }
});

test("expired processing claims can be recovered after a restart", async () => {
  const f = await fixture();
  await Transaction.create({ type: "settlement", settlementRecordKind: "payment", units: f.invoice.units, network: "TRON", transactionHash: f.txHash, invoiceId: f.invoice._id, userId: f.userId, status: "PROCESSING", claimToken: "interrupted", leaseUntil: new Date(0) });
  await verifySettlement(f.userId, String(f.invoice._id), f.txHash, clientFor(chain(f.invoice, f.txHash, null)));
  assert.equal((await Transaction.findOne({ transactionHash: f.txHash }))?.status, "CONFIRMED");
});

test("a superseded claim cannot confirm or release its replacement", async () => {
  const f = await fixture();
  const result = chain(f.invoice, f.txHash, null);
  let replaced = false;
  const factory = (() => ({ post: async (path: string) => {
    if (!replaced) {
      replaced = true;
      await Transaction.updateOne({ transactionHash: f.txHash }, { $set: { claimToken: "replacement" } });
    }
    return { data: path.endsWith("gettransactionbyid") ? result.tx : result.info };
  } })) as any;
  await assert.rejects(verifySettlement(f.userId, String(f.invoice._id), f.txHash, factory), /expired/);
  const claim = (await Transaction.findOne({ transactionHash: f.txHash }))!;
  assert.equal(claim.claimToken, "replacement");
  assert.equal(claim.status, "PROCESSING");
  assert.equal((await Transaction.findById(f.invoice._id))?.status, "AWAITING_PAYMENT");
  assert.equal((await User.findById(f.userId))?.settlementOwedUnits, f.invoice.units);
});

test("database rejects assigning an invoiced trade fee to another invoice", async () => {
  const f = await fixture();
  await assert.rejects(Transaction.create({ type: "settlement", userId: new mongoose.Types.ObjectId(), status: "AWAITING_PAYMENT", units: f.invoice.units, tradeIds: [f.tradeId] }), /duplicate key/);
});

test("different hashes racing to settle one invoice debit its balance only once", async () => {
  const f = await fixture();
  const otherHash = (++sequence).toString(16).padStart(64, "0");
  const results = await Promise.allSettled([f.txHash, otherHash].map(value => verifySettlement(f.userId, String(f.invoice._id), value, clientFor(chain(f.invoice, value)))));
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  assert.equal((await User.findById(f.userId))?.settlementOwedUnits, 0);
  assert.equal(await Transaction.countDocuments({ invoiceId: f.invoice._id, status: "CONFIRMED" }), 1);
  assert.equal(await Notification.countDocuments({ settlementId: f.invoice._id, kind: "settlement_paid" }), 1);
});

test("scanner resumes beyond 1000 transfers and never assigns memo-less payments", async () => {
  const f = await fixture();
  let gets = 0;
  const factory = (() => ({
    get: async (_path: string, { params }: any) => {
      const page = params.fingerprint ? Number(params.fingerprint) : 0;
      gets++;
      if (page < 5) return { data: { data: Array.from({ length: 200 }, () => ({ to: "other" })), meta: { fingerprint: String(page + 1) } } };
      return { data: { data: [{ to: wallet, value: String(f.invoice.units), transaction_id: f.txHash }], meta: {} } };
    },
    post: async (path: string) => ({ data: path.endsWith("gettransactionbyid") ? chain(f.invoice, f.txHash).tx : chain(f.invoice, f.txHash).info }),
  })) as any;
  await scanSettlementInvoice(f.invoice._id, factory);
  const checkpoint = (await Transaction.findById(f.invoice._id))!;
  assert.equal(checkpoint.scanFingerprint, "5");
  assert.equal(checkpoint.status, "AWAITING_PAYMENT");
  await scanSettlementInvoice(f.invoice._id, factory);
  assert.equal(gets, 6);
  assert.equal((await Transaction.findById(f.invoice._id))?.status, "COMPLETED");

  const manual = await fixture();
  const noMemo = chain(manual.invoice, manual.txHash, null);
  const manualFactory = (() => ({ ...clientFor(noMemo)(), get: async () => ({ data: { data: [{ to: wallet, value: String(manual.invoice.units), transaction_id: manual.txHash }], meta: {} } }) })) as any;
  await scanSettlementInvoice(manual.invoice._id, manualFactory);
  assert.equal(await Transaction.countDocuments({ transactionHash: manual.txHash }), 0);
  assert.equal((await Transaction.findById(manual.invoice._id))?.status, "AWAITING_PAYMENT");
  await verifySettlement(manual.userId, String(manual.invoice._id), manual.txHash, manualFactory);
});

test("scanner retries an incomplete page without advancing its checkpoint", async () => {
  const f = await fixture();
  const factory = (() => ({ get: async () => ({ data: { data: [{ to: wallet, value: String(f.invoice.units), transaction_id: f.txHash }], meta: { fingerprint: "next" } } }), post: async () => { throw new Error("API timeout"); } })) as any;
  await assert.rejects(scanSettlementInvoice(f.invoice._id, factory), /API timeout/);
  const invoice = (await Transaction.findById(f.invoice._id))!;
  assert.equal(invoice.scanFingerprint, undefined);
  assert.equal(invoice.scanLeaseUntil, undefined);
  assert.ok(invoice.scanMaxTimestamp);
});

test("automatic copy worker checks settlement independently immediately before execution", async () => {
  const f = await fixture(), proId = new mongoose.Types.ObjectId(), sourceId = new mongoose.Types.ObjectId();
  const subscriptionId = new mongoose.Types.ObjectId(), connectionId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: proId, role: "ProTrader", status: "active", email: `${proId}@example.com`, traderID: String(proId) });
  const startedAt = new Date(Date.now() - 5000);
  await Trade.collection.insertOne({ _id: sourceId, userId: proId, status: "filled", protectionStatus: "confirmed", createdAt: new Date(), pair: "BTCUSDT", tradeOrigin: "pro", signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId() });
  await CopySubscription.collection.insertOne({ _id: subscriptionId, copierId: f.userId, proTraderId: proId, exchangeConnectionId: connectionId, active: true, allocation: 100, startedAt });
  const job = await CopyExecution.create({ sourceTradeId: sourceId, subscriptionId, copierId: f.userId, exchangeConnectionId: connectionId, status: "queued", availableAt: new Date(0) });
  let executions = 0;
  await drainCopyQueue({ refreshConnectionBalance: async () => 1000, executeTrade: async () => { executions++; return { status: 201, body: {} }; } });
  assert.equal(executions, 0);
  assert.equal((await CopyExecution.findById(job._id))?.status, "failed");
  assert.match((await CopyExecution.findById(job._id))?.reason || "", /outstanding profit share/);
  const direct = await executeTrade(f.userId, { sourceTradeId: String(sourceId), exchangeConnectionId: String(connectionId), balance: 100 }, false);
  assert.equal(direct.status, 402);
  assert.equal(direct.body.code, "PROFIT_SHARE_DUE");
});

test("finance summary reads confirmed pro earnings from the dedicated collection", async () => {
  const userId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: userId, email: `${userId}@example.com`, traderID: String(userId), role: "ProTrader", status: "active", isVerified: true, proBalanceUnits: 3_000_000 });
  await Earning.create({ userId, tradeId: new mongoose.Types.ObjectId(), units: 5_000_000, status: "COMPLETED" });
  let payload: any;
  await getFinanceSummary({ user: userId } as any, {
    setHeader() {}, status() { return this; }, json(value: any) { payload = value; return this; },
  } as any);
  assert.equal(payload.success, true);
  assert.equal(payload.earned, "5.000000");
  assert.equal(payload.available, "3.000000");
});

test("withdrawal quotes deduct a live network reserve from the entered total", async () => {
  const factory = (() => ({ defaultAddress: { base58: sender }, trx: { getChainParameters: async () => [
    { key: "getEnergyFee", value: 100 }, { key: "getTransactionFee", value: 1000 }, { key: "getMaxFeeLimit", value: 100_000_000 },
  ] }, transactionBuilder: { estimateEnergy: async () => ({ result: { result: true }, energy_required: 100_000 }) } })) as any;
  const quote = await quoteWithdrawalFee(100_000_000, wallet, factory, async () => 200_000);
  assert.equal(quote.feeLimitSun, 12_500_000);
  assert.equal(quote.networkFeeReserveUnits, 2_704_800);
  assert.equal(quote.payoutUnits + quote.networkFeeReserveUnits, 100_000_000);
  assert.equal(networkFeeUnits(1, 200_000), 1);
  await assert.rejects(quoteWithdrawalFee(1_000_000, wallet, factory, async () => 200_000), /exceed its network fee/);
  await assert.rejects(quoteWithdrawalFee(100_000_000, wallet, factory, async () => { throw new Error("Price API unavailable"); }), /Price API unavailable/);
  const simulation = (() => ({ ...factory(), transactionBuilder: {
    estimateEnergy: async () => { throw new Error("Node disables estimateEnergy"); },
    triggerConstantContract: async () => ({ result: { result: true }, energy_used: 100_000 }),
  } })) as any;
  assert.equal((await quoteWithdrawalFee(100_000_000, wallet, simulation, async () => 200_000)).networkFeeReserveUnits, quote.networkFeeReserveUnits);
});

test("withdrawal bandwidth reserve rejects oversized and memo-bearing payouts", () => {
  const signed = { raw_data_hex: "ab".repeat(250), signature: ["ab".repeat(65)], raw_data: {} };
  assert.doesNotThrow(() => assertWithdrawalSize(signed));
  assert.throws(() => assertWithdrawalSize({ ...signed, raw_data_hex: "ab".repeat(2000) }), /bandwidth/);
  assert.throws(() => assertWithdrawalSize({ ...signed, raw_data: { data: "memo" } }), /bandwidth/);
});

async function feeFixture(status = "SIGNED", available = 10_000_000) {
  const userId = new mongoose.Types.ObjectId();
  const txHash = (++sequence).toString(16).padStart(64, "0");
  const email = `${userId}@example.com`;
  await User.collection.insertOne({ _id: userId, email, traderID: String(userId), role: "ProTrader", status: "active", isVerified: true,
    proBalanceUnits: available, proNetworkFeeOwedUnits: 0, withdrawalAddress: wallet, withdrawalAddressChangedAt: new Date(Date.now() - 2 * 86400_000) });
  const quote = { payoutUnits: 97_000_000, networkFeeReserveUnits: 3_000_000, feeLimitSun: 12_500_000,
    bandwidthSunPerByte: 1000, trxPriceUnits: 200_000, quoteExpiresAt: new Date(Date.now() + 600_000) };
  const result = chain({ ...sample, units: quote.payoutUnits }, txHash, null);
  const tx = { ...result.tx, raw_data: { ...result.tx.raw_data, fee_limit: quote.feeLimitSun }, ret: [{ contractRet: "SUCCESS" }] };
  const info = { ...result.info, fee: 5_000_000 };
  const row = await Transaction.create({ type: "withdrawal", userId, units: 100_000_000, address: wallet, status, requestId: String(new mongoose.Types.ObjectId()),
    ...quote, ...(status === "QUOTED" ? {} : { transactionId: txHash, senderAddress: sender, signedTransaction: tx }) });
  return { userId, row, info, tx, email };
}

test("successful withdrawals charge actual gas and refund unused reserve exactly once", async () => {
  const f = await feeFixture();
  await Promise.all([finishWithdrawal(f.row._id, "COMPLETED", "SIGNED", f.info), finishWithdrawal(f.row._id, "COMPLETED", "SIGNED", f.info)]);
  const row = (await Transaction.findById(f.row._id))!;
  assert.equal(row.networkFeeUnits, 1_000_000);
  assert.equal(row.refundUnits, 2_000_000);
  assert.equal((await User.findById(f.userId))?.proBalanceUnits, 12_000_000);
  assert.equal(row.payoutUnits! + row.networkFeeUnits! + row.refundUnits!, row.units);
  const free = await feeFixture();
  await finishWithdrawal(free.row._id, "COMPLETED", "SIGNED", { ...free.info, fee: 0 });
  assert.equal((await Transaction.findById(free.row._id))?.refundUnits, 3_000_000);
  assert.equal((await User.findById(free.userId))?.proBalanceUnits, 13_000_000);
});

test("failed withdrawals retain consumed gas and refund only unsent funds", async () => {
  const f = await feeFixture();
  const info = { ...f.info, result: "FAILED", receipt: { result: "REVERT" }, log: [] };
  await finishWithdrawal(f.row._id, "FAILED", "SIGNED", info);
  await finishWithdrawal(f.row._id, "FAILED", "SIGNED", info);
  const row = (await Transaction.findById(f.row._id))!;
  assert.equal(row.networkFeeUnits, 1_000_000);
  assert.equal(row.refundUnits, 99_000_000);
  assert.equal((await User.findById(f.userId))?.proBalanceUnits, 109_000_000);
  await assert.rejects(finishWithdrawal((await feeFixture()).row._id, "FAILED", "SIGNED"), /receipt required/);
});

test("invalid fee evidence leaves the withdrawal and balance unchanged", async () => {
  const f = await feeFixture();
  await assert.rejects(finishWithdrawal(f.row._id, "COMPLETED", "SIGNED", { ...f.info, fee: -1 }));
  assert.equal((await Transaction.findById(f.row._id))?.status, "SIGNED");
  assert.equal((await User.findById(f.userId))?.proBalanceUnits, 10_000_000);
  await User.deleteOne({ _id: f.userId });
  await assert.rejects(finishWithdrawal(f.row._id, "COMPLETED", "SIGNED", f.info), /balance unavailable/);
  assert.equal((await Transaction.findById(f.row._id))?.status, "SIGNED");
  assert.equal((await Transaction.findById(f.row._id))?.refundUnits, undefined);
});

test("exceptional network overruns stay owed by the user and future credits cover them", async () => {
  const f = await feeFixture("SIGNED", 1_000_000);
  await finishWithdrawal(f.row._id, "COMPLETED", "SIGNED", { ...f.info, fee: 25_000_000 });
  assert.equal((await Transaction.findById(f.row._id))?.feeOverrunUnits, 2_000_000);
  assert.equal((await User.findById(f.userId))?.proBalanceUnits, 0);
  assert.equal((await User.findById(f.userId))?.proNetworkFeeOwedUnits, 1_000_000);
  await mongoose.connection.transaction(session => adjustProBalance(f.userId, 3_000_000, 0, session));
  assert.equal((await User.findById(f.userId))?.proNetworkFeeOwedUnits, 0);
  assert.equal((await User.findById(f.userId))?.proBalanceUnits, 2_000_000);
});

test("withdrawal reconciliation applies the same fee accounting and cannot refund twice", async () => {
  for (const failed of [false, true]) {
    const f = await feeFixture("REVIEW");
    const info = failed ? { ...f.info, result: "FAILED", receipt: { result: "REVERT" }, log: [] } : f.info;
    const tx = failed ? { ...f.tx, ret: [{ contractRet: "REVERT" }] } : f.tx;
    const factory = (() => ({ trx: { getConfirmedTransaction: async () => tx, getTransactionInfo: async () => info } })) as any;
    await reconcileProWithdrawal(f.row._id, new mongoose.Types.ObjectId(), factory);
    await reconcileProWithdrawal(f.row._id, new mongoose.Types.ObjectId(), factory);
    assert.equal((await Transaction.findById(f.row._id))?.status, failed ? "FAILED" : "COMPLETED");
    assert.equal((await User.findById(f.userId))?.proBalanceUnits, failed ? 109_000_000 : 12_000_000);
  }
});

async function payoutEnvironment(run: () => Promise<void>) {
  const values = { PRO_PAYOUT_LIVE_ENABLED: "true", TRON_COMPANY_PRIVATE_KEY: "1".padStart(64, "0"), OTP_SECRET: "test-only-otp-secret-at-least-32-bytes" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { await run(); } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
function response() {
  return { payload: undefined as any, statusCode: 200, setHeader() {}, status(code: number) { this.statusCode = code; return this; }, json(value: any) { this.payload = value; return this; } };
}

test("OTP approval reserves the gross amount once and uses the server's quoted payout", async () => payoutEnvironment(async () => {
  const f = await feeFixture("QUOTED", 100_000_000);
  const otp = await issueOtp({ email: f.email, purpose: "withdrawal", userId: f.userId, context: withdrawalOtpContext(f.row.units, wallet, f.row.requestId!, f.row) });
  const req = { user: f.userId, body: { amount: "100", otp, payoutUnits: 100_000_000, networkFeeReserveUnits: 0 }, get: () => f.row.requestId };
  const a = response(), b = response();
  await Promise.all([withdrawFunds(req as any, a as any), withdrawFunds(req as any, b as any)]);
  assert.equal(a.payload.success, true);
  assert.equal(b.payload.success, true);
  assert.equal((await User.findById(f.userId))?.proBalanceUnits, 0);
  assert.equal((await Transaction.findById(f.row._id))?.status, "QUEUED");
  assert.equal((await Transaction.findById(f.row._id))?.payoutUnits, 97_000_000);
  assert.equal(await Transaction.countDocuments({ userId: f.userId, type: "withdrawal", status: "QUEUED" }), 1);
}));

test("expired quotes and changes to OTP-bound fees cannot reserve funds", async () => payoutEnvironment(async () => {
  for (const expired of [false, true]) {
    const f = await feeFixture("QUOTED", 100_000_000);
    const otp = await issueOtp({ email: f.email, purpose: "withdrawal", userId: f.userId, context: withdrawalOtpContext(f.row.units, wallet, f.row.requestId!, f.row) });
    await Transaction.updateOne({ _id: f.row._id }, { $set: expired ? { quoteExpiresAt: new Date(0) } : { payoutUnits: 96_000_000, networkFeeReserveUnits: 4_000_000 } });
    const res = response();
    await withdrawFunds({ user: f.userId, body: { amount: "100", otp }, get: () => f.row.requestId } as any, res as any);
    assert.equal(res.statusCode, 400);
    assert.equal((await User.findById(f.userId))?.proBalanceUnits, 100_000_000);
    assert.equal((await Transaction.findById(f.row._id))?.status, "QUOTED");
  }
}));

test("unquoted pending withdrawals cannot broadcast at the company's expense", async () => payoutEnvironment(async () => {
  const f = await feeFixture("QUEUED");
  await Transaction.updateOne({ _id: f.row._id }, { $unset: { payoutUnits: 1, networkFeeReserveUnits: 1, transactionId: 1, signedTransaction: 1 } });
  let calls = 0;
  await processProWithdrawal(f.row._id, (() => { calls++; throw new Error("Must not broadcast"); }) as any);
  assert.equal(calls, 0);
  assert.equal((await Transaction.findById(f.row._id))?.status, "FAILED");
  assert.equal((await User.findById(f.userId))?.proBalanceUnits, 110_000_000);
}));
