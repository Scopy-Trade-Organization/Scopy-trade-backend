import { randomUUID } from "node:crypto";
import { Transaction } from "../models/transactionModel.js";
import axios from "axios";
import mongoose from "mongoose";
import { TronWeb } from "tronweb";
import { Trade } from "../models/tradeModel.js";
import { Notification } from "../models/notificationModel.js";
import User from "../models/userModel.js";
import { usdtUnits, formatUsdt } from "../helpers/usdt.js";
import { getProfitShareSummary } from "./profitSharingService.js";
import { MAINNET_USDT, TRANSFER_TOPIC, creditProEarning, tronHost } from "./proFinanceService.js";
import { sendEmail } from "./emailService.js";

export function settlementWallet() {
  const address = process.env.SYSTEM_WALLET_ADDRESS?.trim();
  if (!address || !TronWeb.isAddress(address)) throw new Error("Configure a valid SYSTEM_WALLET_ADDRESS.");
  return address;
}

export async function ensureSettlement(userId: mongoose.Types.ObjectId) {
  let invoice = await Transaction.findOne({ type: "settlement", userId, status: "AWAITING_PAYMENT" }).lean();
  if (!invoice) {
    const summary = await getProfitShareSummary(userId);
    if (!summary.settlementRequired) return null;
    const address = settlementWallet();
    try {
      await mongoose.connection.transaction(async session => {
        if (await Transaction.exists({ type: "settlement", userId, status: "AWAITING_PAYMENT" }).session(session)) return;
        const trades = await Trade.find({ userId, tradeOrigin: "copy", tradeResult: "profit", feeStatus: { $in: ["pending", "failed"] }, settlementBatchId: null }).session(session).lean();
        const units = trades.reduce((sum, trade) => sum + usdtUnits(trade.platformFee || "0"), 0);
        if (!Number.isSafeInteger(units)) throw new Error("Settlement amount exceeds supported precision.");
        if (units < usdtUnits(summary.threshold)) return;
        const id = new mongoose.Types.ObjectId();
        const batchId = id.toString();
        await Transaction.create([{ type: "settlement", settlementRecordKind: "invoice",
          _id: id, userId, memo: `SCOPY-${batchId}`,
          tradeIds: trades.map(trade => trade._id), units,
          address, status: "AWAITING_PAYMENT",
        }], { session });
        const assigned = await Trade.updateMany({ userId, settlementBatchId: null, _id: { $in: trades.map(trade => trade._id) }, feeStatus: { $in: ["pending", "failed"] } }, {
          $set: { feeStatus: "processing", settlementBatchId: batchId, settlementStartedAt: new Date() },
        }, { session });
        if (assigned.modifiedCount !== trades.length) throw new SettlementVerificationError("Trade fee allocation changed; retry invoice creation.");
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    invoice = await Transaction.findOne({ type: "settlement", userId, status: "AWAITING_PAYMENT" }).lean();
  }
  if (invoice) await Notification.updateOne({ settlementId: invoice._id, kind: "settlement_due" }, {
    $setOnInsert: { userId, title: "Profit-share settlement due", message: `Log into your dashboard and pay ${formatUsdt(invoice.units)} USDT on TRON to ${invoice.address}. Include memo ${invoice.memo} if supported, otherwise submit your transaction hash in the dashboard. New copied trades are paused until payment is confirmed.` },
  }, { upsert: true });
  return invoice;
}

function api() {
  const host = tronHost();
  return axios.create({ baseURL: host, timeout: 15_000, headers: process.env.TRON_PRO_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRON_PRO_API_KEY } : {} });
}

const hex = (address: string) => TronWeb.address.toHex(address).slice(2).toLowerCase();
export class SettlementVerificationError extends Error {
  constructor(message: string, public retryable = false) { super(message); }
}

export function normalizeSettlementHash(hash: string) {
  const normalized = hash.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new SettlementVerificationError("Enter a valid 64-character transaction hash.");
  return normalized;
}

export function settlementMemo(tx: any): string {
  const data = tx?.raw_data?.data;
  if (data === undefined || data === "") return "";
  if (typeof data !== "string" || !/^(?:[a-f0-9]{2})+$/i.test(data)) throw new SettlementVerificationError("Invalid transaction memo.");
  return Buffer.from(data, "hex").toString("utf8");
}

/** Pure receipt validation, shared by automatic and hash-based verification. */
export function validateSettlementReceipt(invoice: any, hash: string, tx: any, info: any) {
  if (!tx?.txID || !info?.id) throw new SettlementVerificationError("Payment is not yet available as a solidified transaction. Retry shortly.", true);
  if (tx?.txID?.toLowerCase() !== hash || info?.id?.toLowerCase() !== hash ||
      info?.receipt?.result !== "SUCCESS" || info?.result === "FAILED" ||
      !Number.isSafeInteger(info?.blockNumber) || info.blockNumber < 1 ||
      !Number.isFinite(info?.blockTimeStamp) || info.blockTimeStamp < new Date(invoice.createdAt).getTime()) {
    throw new SettlementVerificationError("Payment is not a successful confirmed transfer made after this invoice was created.");
  }
  const contracts = tx?.raw_data?.contract;
  const value = contracts?.[0]?.parameter?.value;
  if (contracts?.length !== 1 || contracts[0]?.type !== "TriggerSmartContract" ||
      String(value?.contract_address).toLowerCase() !== TronWeb.address.toHex(MAINNET_USDT).toLowerCase() ||
      !/^(41)[0-9a-f]{40}$/i.test(value?.owner_address || "")) throw new SettlementVerificationError("Expected a direct mainnet USDT transfer.");
  const sender = TronWeb.address.fromHex(value.owner_address);
  const memo = settlementMemo(tx);
  if (memo && memo !== invoice.memo) throw new SettlementVerificationError("Payment memo belongs to a different invoice.");
  const expected = "a9059cbb" + hex(invoice.address).padStart(64, "0") + BigInt(invoice.units).toString(16).padStart(64, "0");
  if (String(value.data).toLowerCase() !== expected || Number(value.call_value || 0) !== 0) throw new SettlementVerificationError("Payment recipient or amount does not match the invoice. Send the exact USDT amount.");
  const matched = info.log?.some((log: any) =>
    String(log.address).toLowerCase().replace(/^41(?=[a-f0-9]{40}$)/, "") === hex(MAINNET_USDT) &&
    log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC &&
    log.topics?.[1]?.toLowerCase() === hex(sender).padStart(64, "0") &&
    log.topics?.[2]?.toLowerCase() === hex(invoice.address).padStart(64, "0") &&
    /^[a-f0-9]{64}$/i.test(log.data || "") && BigInt("0x" + log.data) === BigInt(invoice.units));
  if (!matched) throw new SettlementVerificationError("Confirmed receipt does not contain the expected USDT transfer.");
  return sender;
}

export async function verifySettlement(userId: mongoose.Types.ObjectId, id: string, hash: string, clientFactory = api) {
  if (!mongoose.isValidObjectId(id)) throw new SettlementVerificationError("Enter a valid settlement ID.");
  hash = normalizeSettlementHash(hash);
  const invoice = await Transaction.findOne({ type: "settlement", _id: id, userId }).lean();
  if (!invoice) throw new SettlementVerificationError("Settlement not found.");
  if (invoice.status === "COMPLETED") {
    if (invoice.transactionId !== hash) throw new SettlementVerificationError("This invoice was paid with a different transaction.");
    return invoice;
  }
  if (invoice.status !== "AWAITING_PAYMENT" || !invoice.units || !invoice.memo) throw new SettlementVerificationError("Invoice requires operator review.");
  // Preserve the global protection for hashes already recorded on invoices or payouts.
  if (await Transaction.exists({ transactionId: { $regex: `^${hash}$`, $options: "i" } })) {
    throw new SettlementVerificationError("Transaction hash has already been used.");
  }
  const key = { type: "settlement", settlementRecordKind: "payment", network: "TRON", transactionHash: hash };
  const existing = await Transaction.findOne(key).lean();
  if (existing?.status === "CONFIRMED") throw new SettlementVerificationError("Transaction hash has already been used.");
  const claimToken = randomUUID();
  const claim = { units: invoice.units, address: invoice.address, invoiceId: invoice._id, userId, status: "PROCESSING", claimToken,
    leaseUntil: new Date(Date.now() + 120_000), retryable: false, lastError: "" };
  try {
    if (!existing) await Transaction.create({ ...key, ...claim });
    else {
      // A failed verification releases the hash; an interrupted process can be recovered.
      const recovered = await Transaction.findOneAndUpdate({ ...key, $or: [
        { status: "REJECTED" }, { status: "PROCESSING", leaseUntil: { $lte: new Date() } },
      ] }, { $set: claim });
      if (!recovered) throw new SettlementVerificationError("Transaction hash is already being processed. Retry shortly.", true);
    }
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new SettlementVerificationError("Transaction hash is already claimed or used. Retry shortly.", true);
    throw error;
  }
  try {
    const client = clientFactory();
    // Solidity endpoints supply solidified inclusion and the execution receipt.
    const [{ data: tx }, { data: info }] = await Promise.all([
      client.post("/walletsolidity/gettransactionbyid", { value: hash }),
      client.post("/walletsolidity/gettransactioninfobyid", { value: hash }),
    ]);
    const senderAddress = validateSettlementReceipt(invoice, hash, tx, info);
    await mongoose.connection.transaction(async session => {
      // Fence old requests whose lease was recovered by another process.
      const payment = await Transaction.updateOne({ ...key, status: "PROCESSING", claimToken }, {
        $set: { status: "CONFIRMED", confirmedAt: new Date(), retryable: false, lastError: "" },
      }, { session });
      if (payment.modifiedCount !== 1) throw new SettlementVerificationError("Payment claim expired; retry verification.", true);
      const paid = await Transaction.findOneAndUpdate({ type: "settlement", _id: id, userId, status: "AWAITING_PAYMENT" }, {
        $set: { status: "COMPLETED", transactionId: hash, senderAddress, completedAt: new Date(), lastError: null },
      }, { session, new: true });
      if (!paid) throw new SettlementVerificationError("Invoice has already been paid.");
      const trades = await Trade.find({ _id: { $in: paid.tradeIds }, userId, tradeOrigin: "copy", tradeResult: "profit",
        settlementBatchId: String(paid._id), feeStatus: "processing" }).session(session).lean();
      if (trades.length !== paid.tradeIds.length || trades.reduce((sum, trade) => sum + usdtUnits(trade.platformFee || "0"), 0) !== paid.units) {
        throw new SettlementVerificationError("Invoice trade fees do not reconcile. Contact support.");
      }
      const updated = await User.updateOne({ _id: userId, settlementOwedUnits: { $gte: paid.units } }, { $inc: { settlementOwedUnits: -paid.units } }, { session });
      if (updated.matchedCount !== 1) throw new SettlementVerificationError("Settlement balance unavailable.");
      const collected = await Trade.updateMany({ userId, _id: { $in: paid.tradeIds }, settlementBatchId: String(paid._id), feeStatus: "processing" }, {
        $set: { feeStatus: "collected", settlementTransactionId: hash, settlementBlockchainTransactionId: hash, settlementNetwork: "TRON", settlementAddress: paid.address, settlementCompletedAt: paid.completedAt },
      }, { session });
      if (collected.modifiedCount !== trades.length) throw new SettlementVerificationError("Trade fee allocation changed.");
      // Copying access is derived from this balance and processing fees, not a separate flag.
      await Notification.create([{ userId, settlementId: paid._id, kind: "settlement_paid", title: "Settlement confirmed", message: `Your ${formatUsdt(paid.units)} USDT settlement has been confirmed.` }], { session });
    });
  } catch (error) {
    // If a commit result is ambiguous, this predicate cannot release a confirmed hash.
    await Transaction.updateOne({ ...key, status: "PROCESSING", claimToken }, { $set: {
      status: "REJECTED", retryable: !(error instanceof SettlementVerificationError) || error.retryable,
      lastError: error instanceof SettlementVerificationError ? error.message : "Verification temporarily unavailable. Retry shortly.",
    } }).catch(() => undefined); // A DB outage leaves an expiring lease, never an unlocked confirmed hash.
    throw error;
  }
  for (const tradeId of invoice.tradeIds) {
    await creditProEarning(tradeId).catch(() => console.error("[Settlement] Pro credit requires retry", String(tradeId)));
  }
  return Transaction.findOne({ type: "settlement", _id: id, userId }).lean();
}

async function deliverSettlementEmails() {
  for (let i = 0; i < 20; i++) {
    const notification = await Notification.findOneAndUpdate({ kind: "settlement_due", emailSentAt: null,
      $or: [{ emailLeaseUntil: null }, { emailLeaseUntil: { $lt: new Date() } }],
    }, { $set: { emailLeaseUntil: new Date(Date.now() + 5 * 60_000) } }, { new: true });
    if (!notification) break;
    try {
      const invoice = await Transaction.findOne({ type: "settlement", _id: notification.settlementId, status: "AWAITING_PAYMENT" }).lean();
      if (invoice) {
        const user = await User.findById(notification.userId).select("email").lean();
        if (!user) throw new Error("Recipient unavailable");
        const url = `${(process.env.FRONTEND_URL || "").replace(/\/$/, "")}/dashboard/copy-trader`;
        const text = `${notification.message}\nDashboard: ${url}\nPay the exact amount. Pay all exchange withdrawal and network fees separately so the full invoice amount arrives. Keep TRX in your sending wallet for gas. Never share your private key.`;
        const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        await sendEmail({ to: user.email, subject: notification.title, text, html: `<p style="white-space:pre-wrap">${escaped}</p>` });
      }
      await Notification.updateOne({ _id: notification._id }, { $set: { emailSentAt: new Date(), emailLastError: null } });
    } catch {
      await Notification.updateOne({ _id: notification._id }, { $set: { emailLastError: "Email delivery failed; retry scheduled." } });
    }
  }
}

/** Checkpoint only complete pages. Replaying a page is safe through the hash claim. */
export async function scanSettlementInvoice(id: mongoose.Types.ObjectId, clientFactory = api) {
  const scanToken = randomUUID();
  const invoice = await Transaction.findOneAndUpdate({ _id: id, type: "settlement", status: "AWAITING_PAYMENT",
    $or: [{ scanLeaseUntil: null }, { scanLeaseUntil: { $lte: new Date() } }],
  }, { $set: { scanToken, scanLeaseUntil: new Date(Date.now() + 300_000) } }, { new: true }).lean();
  if (!invoice) return;
  try {
    const min = invoice.scanMinTimestamp ?? invoice.createdAt.getTime();
    const max = invoice.scanMaxTimestamp ?? Math.max(min, Date.now() - 120_000);
    await Transaction.updateOne({ _id: id, scanToken }, { $set: { scanMinTimestamp: min, scanMaxTimestamp: max } });
    const client = clientFactory();
    let fingerprint = invoice.scanFingerprint;
    for (let page = 0; page < 5; page++) {
      let data: any;
      try {
        ({ data } = await client.get(`/v1/accounts/${invoice.address}/transactions/trc20`, { params: {
          only_confirmed: true, only_to: true, contract_address: MAINNET_USDT,
          min_timestamp: min, max_timestamp: max, order_by: "block_timestamp,asc", limit: 200,
          ...(fingerprint ? { fingerprint } : {}),
        } }));
      } catch (error) {
        // An expired provider cursor can be replayed within the same fixed window.
        if (fingerprint && axios.isAxiosError(error) && error.response?.status === 400) {
          await Transaction.updateOne({ _id: id, scanToken }, { $unset: { scanFingerprint: 1 } });
        }
        throw error;
      }
      if (!Array.isArray(data?.data) || data.success === false) throw new SettlementVerificationError("Invalid blockchain history response.", true);
      for (const item of data.data) {
        if (item.to !== invoice.address || item.value !== String(invoice.units)) continue;
        const hash = normalizeSettlementHash(item.transaction_id);
        const { data: tx } = await client.post("/walletsolidity/gettransactionbyid", { value: hash });
        if (!tx?.txID) throw new SettlementVerificationError("Solidified transaction temporarily unavailable.", true);
        // Never claim a memo-less payment on behalf of a guessed user.
        let memo: string;
        try { memo = settlementMemo(tx); } catch { continue; }
        if (!memo || memo !== invoice.memo) continue;
        try {
          await verifySettlement(invoice.userId, String(id), hash, clientFactory);
          return;
        } catch (error) {
          if (!(error instanceof SettlementVerificationError) || error.retryable) throw error;
        }
      }
      fingerprint = data.meta?.fingerprint;
      const checkpoint = fingerprint
        ? { $set: { scanFingerprint: fingerprint, scanLeaseUntil: new Date(Date.now() + 300_000) } }
        : { $set: { scanMinTimestamp: Math.max(min, max - 60_000) }, $unset: { scanFingerprint: 1, scanMaxTimestamp: 1 } };
      const saved = await Transaction.updateOne({ _id: id, scanToken, status: "AWAITING_PAYMENT" }, checkpoint);
      if (!saved.matchedCount || !fingerprint) break;
    }
  } finally {
    await Transaction.updateOne({ _id: id, scanToken }, { $unset: { scanLeaseUntil: 1, scanToken: 1 }, $set: { updatedAt: new Date() } });
  }
}

let running = false;
let userCursor: mongoose.Types.ObjectId | undefined;
export async function runSettlementWorker() {
  if (running) return;
  running = true;
  try {
    // Sweep catches failures during trade close and fees accrued before deployment.
    const users = await User.find({ role: "CopyTrader", ...(userCursor ? { _id: { $gt: userCursor } } : {}) }).sort({ _id: 1 }).limit(100).select("_id").lean();
    for (const user of users) await ensureSettlement(user._id).catch(() => console.error("[Settlement] Invoice requires retry", String(user._id)));
    userCursor = users.length === 100 ? users[users.length - 1]!._id : undefined;
    await deliverSettlementEmails();
    if (process.env.SETTLEMENT_AUTO_VERIFY_ENABLED !== "true") return;
    const invoices = await Transaction.find({ type: "settlement", status: "AWAITING_PAYMENT" }).sort({ updatedAt: 1 }).limit(20).lean();
    for (const invoice of invoices) {
      await scanSettlementInvoice(invoice._id).catch(() => console.error("[Settlement] Automatic verification unavailable; retry scheduled"));
    }
  } finally { running = false; }
}

export async function initializeSettlements() {
  await Transaction.createIndexes();
  await Notification.createIndexes();
  void runSettlementWorker().catch(() => console.error("[Settlement] Worker unavailable"));
  const timer = setInterval(() => { void runSettlementWorker().catch(() => console.error("[Settlement] Worker unavailable")); }, 60_000);
  timer.unref();
}
