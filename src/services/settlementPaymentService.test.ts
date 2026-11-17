import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { TronWeb } from "tronweb";
import { ensureSettlement, validateSettlementReceipt, verifySettlement, ownershipMessage } from "./settlementPaymentService.js";
import { MAINNET_USDT, TRANSFER_TOPIC, finishWithdrawal } from "./proFinanceService.js";
import { Transaction } from "../models/transactionModel.js";
import { Notification } from "../models/notificationModel.js";
import { Trade } from "../models/tradeModel.js";
import User from "../models/userModel.js";
import { migrateFinancialRecords } from "./financialMigrationService.js";

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

test("hash fallback without a memo requires proof from the actual sending wallet", async () => {
  const { tx, info } = receipt(sample, null);
  assert.throws(() => validateSettlementReceipt(sample, hash, tx, info));
  const signer = new TronWeb({ fullHost: "https://api.trongrid.io", privateKey: senderKey });
  const signature = await signer.trx.signMessageV2(ownershipMessage(String(sample._id)));
  assert.equal(validateSettlementReceipt(sample, hash, tx, info, signature), sender);
  assert.throws(() => validateSettlementReceipt({ ...sample, _id: new mongoose.Types.ObjectId() }, hash, tx, info, signature));
});

let replica: MongoMemoryReplSet;
before(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all([Transaction.init(), Notification.init()]);
  process.env.SYSTEM_WALLET_ADDRESS = wallet;
  process.env.SYSTEM_WALLET_NETWORK = "TRON";
}, { timeout: 180_000 });
after(async () => { await mongoose.disconnect(); await replica?.stop(); });

test("invoice creation, notification, chain completion and earnings are idempotent", async () => {
  const copierId = new mongoose.Types.ObjectId(), proId = new mongoose.Types.ObjectId();
  const sourceId = new mongoose.Types.ObjectId(), tradeId = new mongoose.Types.ObjectId();
  await User.collection.insertMany([{ _id: copierId, email: "copier@example.com", traderID: "copy-test", role: "CopyTrader" }, { _id: proId, email: "pro@example.com", traderID: "pro-test", proBalanceUnits: 0 }]);
  await Trade.collection.insertMany([{ _id: sourceId, tradeOrigin: "pro", userId: proId, signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId() }, {
    _id: tradeId, userId: copierId, sourceTradeId: sourceId, signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId(), tradeOrigin: "copy", tradeResult: "profit", status: "closed",
    platformFee: "12.000000", proTraderShare: "6.000000", feeStatus: "pending", proTraderCreditStatus: "pending",
  }]);
  const invoices = await Promise.all([ensureSettlement(copierId), ensureSettlement(copierId)]);
  const invoice = invoices[0]!;
  assert.equal(String(invoice._id), String(invoices[1]!._id));
  assert.equal(await Notification.countDocuments({ userId: copierId, kind: "settlement_due" }), 1);
  assert.equal((await Trade.findById(tradeId).lean())?.feeStatus, "processing");
  const { tx, info } = receipt(invoice);
  const factory = (() => ({ post: async (path: string) => ({ data: path.endsWith("gettransactionbyid") ? tx : info }) })) as any;
  await verifySettlement(copierId, String(invoice._id), hash, undefined, factory);
  await verifySettlement(copierId, String(invoice._id), hash, undefined, factory);
  assert.equal((await Transaction.findOne({ type: "settlement", _id: invoice._id }).lean())?.status, "COMPLETED");
  assert.equal((await Trade.findById(tradeId).lean())?.feeStatus, "collected");
  assert.equal((await User.findById(proId).lean())?.proBalanceUnits, 6_000_000);
  assert.equal(await Transaction.countDocuments({ type: "earning", tradeId }), 1);
  assert.equal(await Transaction.countDocuments({ userId: proId, type: "earning" }), 1);
  assert.equal(await Notification.countDocuments({ userId: copierId, kind: "settlement_paid" }), 1);
  await assert.rejects(verifySettlement(new mongoose.Types.ObjectId(), String(invoice._id), hash, undefined, factory), /not found/);
  await assert.rejects(Transaction.create({ type: "withdrawal", userId: proId, requestId: "duplicate-hash", status: "QUEUED", units: 1, address: wallet, transactionId: hash }), /duplicate key/);
  assert.equal(await ensureSettlement(copierId), null);
});

test("threshold and fixed invoice protect later trade fees from being marked paid", async () => {
  const userId = new mongoose.Types.ObjectId();
  const id = new mongoose.Types.ObjectId();
  await Trade.collection.insertOne({ _id: id, userId, signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId(), tradeOrigin: "copy", tradeResult: "profit", platformFee: "9.999999", feeStatus: "pending" });
  assert.equal(await ensureSettlement(userId), null);
  await Trade.collection.updateOne({ _id: id }, { $set: { platformFee: "10.000000" } });
  const invoice = await ensureSettlement(userId);
  assert.equal(invoice?.units, 10_000_000);
  await Trade.collection.insertOne({ userId, signalId: new mongoose.Types.ObjectId(), exchangeConnectionId: new mongoose.Types.ObjectId(), tradeOrigin: "copy", tradeResult: "profit", platformFee: "2.000000", feeStatus: "pending" });
  assert.equal((await ensureSettlement(userId))?.units, 10_000_000);
  assert.equal(await Trade.countDocuments({ userId, feeStatus: "pending" }), 1);
});

test("legacy migration preserves IDs and supports restarting without duplicates", async () => {
  const id = new mongoose.Types.ObjectId(), userId = new mongoose.Types.ObjectId();
  await mongoose.connection.db!.collection("prowithdrawals").insertOne({ _id: id, userId, requestId: "old", units: 100, mode: "live", status: "COMPLETED", address: wallet, createdAt: new Date() });
  await migrateFinancialRecords(); await migrateFinancialRecords();
  assert.equal(await Transaction.countDocuments({ type: "withdrawal", _id: id }), 1);
  assert.equal(await Transaction.countDocuments({ type: "earning", _id: id }), 0);
});

test("demo finance is excluded and existing records use only the unified schema fields", async () => {
  const id = new mongoose.Types.ObjectId(), userId = new mongoose.Types.ObjectId();
  await Transaction.collection.insertOne({ _id: id, userId, type: "withdrawal", units: 100_000_000, mode: "demo", status: "QUEUED" });
  await User.collection.insertOne({ _id: userId, email: "migration@example.com", traderID: "migration-test", proLiveUnits: 42_000_000, proDemoUnits: 100_000_000 });
  await migrateFinancialRecords();
  assert.equal(await Transaction.countDocuments({ _id: id }), 0);
  assert.equal(await mongoose.connection.db!.collection("legacy_demo_transactions").countDocuments({ _id: id }), 1);
  const user = await User.findById(userId).lean();
  assert.equal(user?.proBalanceUnits, 42_000_000);
  assert.equal((await User.collection.findOne({ _id: userId }))?.proDemoUnits, undefined);
  assert.equal(Transaction.discriminators, undefined);
  for (const field of ["mode", "simulated", "fundingMode", "batchId", "amount", "blockchainTransactionId", "destinationAddress", "accountType", "availableUsdt"]) {
    assert.equal(Transaction.schema.path(field), undefined);
  }
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
