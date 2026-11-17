import { Transaction } from "../models/transactionModel.js";
import mongoose from "mongoose";
import { TronWeb } from "tronweb";
import User from "../models/userModel.js";
import AuditLog from "../models/auditLogModel.js";
import { Trade } from "../models/tradeModel.js";
import { usdtUnits } from "../helpers/usdt.js";

export const MAINNET_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
export const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export function liveClient() {
  if (process.env.PRO_PAYOUT_LIVE_ENABLED !== "true") throw new Error("Live payouts are disabled.");
  const privateKey = process.env.TRON_COMPANY_PRIVATE_KEY;
  if (!privateKey || !/^[0-9a-f]{64}$/i.test(privateKey)) throw new Error("Configure the company signing key.");
  const host = process.env.TRON_FULL_HOST || "https://api.trongrid.io";
  if (new URL(host).protocol !== "https:") throw new Error("TRON_FULL_HOST must use HTTPS.");
  if (process.env.TRON_USDT_CONTRACT_ADDRESS && process.env.TRON_USDT_CONTRACT_ADDRESS !== MAINNET_USDT) {
    throw new Error("Live payouts require the mainnet USDT contract.");
  }
  return new TronWeb({ fullHost: host, privateKey, ...(process.env.TRON_PRO_API_KEY ? { headers: { "TRON-PRO-API-KEY": process.env.TRON_PRO_API_KEY } } : {}) });
}

/** Only paid settlements can fund earnings. */
export async function creditProEarning(tradeId: mongoose.Types.ObjectId): Promise<void> {
  await mongoose.connection.transaction(async session => {
    const trade = await Trade.findOne({ _id: tradeId, feeStatus: "collected", proTraderCreditStatus: "pending" }).session(session).lean();
    if (!trade?.sourceTradeId || !trade.settlementBatchId) return;
    const settlement = await Transaction.findOne({ type: "settlement", _id: trade.settlementBatchId, status: "COMPLETED", tradeIds: trade._id }).session(session).lean();
    if (!settlement) return;
    const source = await Trade.findOne({ _id: trade.sourceTradeId, tradeOrigin: "pro" }).session(session).lean();
    if (!source) throw new Error("Missing source pro trade.");
    const units = usdtUnits(trade.proTraderShare || "0");
    const field = "proBalanceUnits";
    await Transaction.create([{ type: "earning", tradeId: trade._id, userId: source.userId, status: "COMPLETED", units }], { session });
    const credited = await User.updateOne(
      { _id: source.userId, $or: [{ [field]: { $lte: Number.MAX_SAFE_INTEGER - units } }, { [field]: { $exists: false } }] },
      { $inc: { [field]: units } }, { session },
    );
    if (credited.matchedCount !== 1) throw new Error("Earnings balance unavailable.");
    await Trade.updateOne({ _id: trade._id }, { $set: { proTraderCreditStatus: "credited", proTraderCreditedAt: new Date() } }, { session });
  }, { writeConcern: { w: "majority" }, readConcern: { level: "snapshot" } });
}

export function assertPayoutTransaction(transaction: any, address: string, units: number, sender: string) {
  const contracts = transaction?.raw_data?.contract;
  const contract = contracts?.[0];
  const value = contract?.parameter?.value;
  const expectedData = "a9059cbb" + TronWeb.address.toHex(address).slice(2).toLowerCase().padStart(64, "0") + BigInt(units).toString(16).padStart(64, "0");
  if (contracts?.length !== 1 || contract.type !== "TriggerSmartContract" ||
    String(value?.owner_address).toLowerCase() !== TronWeb.address.toHex(sender).toLowerCase() ||
    String(value?.contract_address).toLowerCase() !== TronWeb.address.toHex(MAINNET_USDT).toLowerCase() ||
    String(value?.data).toLowerCase() !== expectedData ||
    Number(value?.call_value || 0) !== 0 || Number(value?.call_token_value || 0) !== 0 ||
    Number(transaction.raw_data.fee_limit) !== 100_000_000) {
    throw new Error("Refusing to sign an unexpected transaction.");
  }
}

export function transferConfirmed(info: any, address: string, units: number, sender: string): boolean {
  if (info?.receipt?.result !== "SUCCESS" || info?.result === "FAILED") return false;
  const hex = (value: string) => TronWeb.address.toHex(value).slice(2).toLowerCase();
  return Array.isArray(info.log) && info.log.some((log: any) =>
    String(log.address).toLowerCase().replace(/^41(?=[0-9a-f]{40}$)/, "") === hex(MAINNET_USDT) &&
    log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC &&
    log.topics?.[1]?.toLowerCase() === hex(sender).padStart(64, "0") &&
    log.topics?.[2]?.toLowerCase() === hex(address).padStart(64, "0") &&
    /^[0-9a-f]{64}$/i.test(log.data || "") && BigInt("0x" + log.data) === BigInt(units)
  );
}

/** Status transition and any refund commit together; concurrent workers cannot refund twice. */
export async function finishWithdrawal(id: mongoose.Types.ObjectId, status: "COMPLETED" | "FAILED", from: "QUEUED" | "SIGNED") {
  await mongoose.connection.transaction(async session => {
    const row = await Transaction.findOneAndUpdate({ type: "withdrawal", _id: id, status: from },
      { $set: { status, completedAt: new Date(), lastError: status === "FAILED" ? "Confirmed on-chain execution failure; balance refunded." : null } },
      { new: true, session });
    if (!row) return;
    await AuditLog.create([{ userId: row.userId, action: "Pro Withdrawal " + status, targetId: row._id, details: { units: row.units, transactionId: row.transactionId } }], { session });
    if (status !== "FAILED") return;
    const refund = await User.updateOne({ _id: row.userId, proBalanceUnits: { $lte: Number.MAX_SAFE_INTEGER - row.units } }, { $inc: { proBalanceUnits: row.units } }, { session });
    if (refund.matchedCount !== 1) throw new Error("Refund account missing.");
  }, { writeConcern: { w: "majority" }, readConcern: { level: "snapshot" } });
}

/** Preparing twice is harmless: only the CAS winner persists and broadcasts its transaction. */
export async function processProWithdrawal(id: mongoose.Types.ObjectId, clientFactory: typeof liveClient = liveClient) {
  let row = await Transaction.findOne({ type: "withdrawal", _id: id }).readConcern("majority").select("+signedTransaction").lean();
  if (!row || !["QUEUED", "SIGNED"].includes(row.status)) return;
  if (!row.address) throw new Error("Withdrawal address missing.");
  if (process.env.PRO_PAYOUT_LIVE_ENABLED !== "true") return;
  const tron = clientFactory();
  const sender = tron.defaultAddress.base58;
  if (!sender) throw new Error("Company address unavailable.");
  if (row.status === "QUEUED") {
    const user = await User.findOne({ _id: row.userId, status: "active", isVerified: true }).lean();
    if (!user) {
      await Transaction.updateOne({ type: "withdrawal", _id: id, status: "QUEUED" }, { $set: { lastError: "Payout paused while account is inactive." } });
      return;
    }
    const contract = await tron.contract().at(MAINNET_USDT);
    const balance = await contract.balanceOf(sender).call();
    if (BigInt(balance.toString()) < BigInt(row.units)) throw new Error("Company wallet needs USDT.");
    const built = await tron.transactionBuilder.triggerSmartContract(
      MAINNET_USDT, "transfer(address,uint256)", { feeLimit: 100_000_000 },
      [{ type: "address", value: row.address }, { type: "uint256", value: String(row.units) }], sender,
    );
    if (!built.result?.result) throw new Error("Unable to prepare transfer.");
    const extended = await tron.transactionBuilder.extendExpiration(built.transaction, 600);
    assertPayoutTransaction(extended, row.address!, row.units, sender);
    const signed = await tron.trx.sign(extended);
    const saved = await Transaction.findOneAndUpdate({ type: "withdrawal", _id: id, status: "QUEUED" },
      { $set: { status: "SIGNED", signedTransaction: signed, senderAddress: sender, transactionId: signed.txID, expiresAt: new Date(signed.raw_data.expiration) } },
      { new: true, writeConcern: { w: "majority" } }).select("+signedTransaction").lean();
    if (!saved) return;
    row = saved;
  }
  if (!row.transactionId || !row.signedTransaction) throw new Error("Missing durable transaction.");
  const info = await tron.trx.getTransactionInfo(row.transactionId);
  if (info?.id) {
    if (info.id !== row.transactionId) throw new Error("Unexpected receipt ID.");
    if (transferConfirmed(info, row.address!, row.units, sender)) {
      await finishWithdrawal(id, "COMPLETED", "SIGNED");
    } else if (info.receipt?.result && info.receipt.result !== "SUCCESS") {
      await finishWithdrawal(id, "FAILED", "SIGNED");
    } else {
      await Transaction.updateOne({ type: "withdrawal", _id: id, status: "SIGNED" }, { $set: { status: "REVIEW", lastError: "Confirmed receipt requires operator review." } });
    }
    return;
  }
  if (!row.expiresAt || row.expiresAt.getTime() <= Date.now()) {
    // Absence is not evidence of failure. Never re-sign or refund on a timeout.
    await Transaction.updateOne({ type: "withdrawal", _id: id, status: "SIGNED" }, { $set: { status: "REVIEW", lastError: "Transaction expired without a confirmed receipt. Funds held for review." } });
    return;
  }
  await tron.trx.sendRawTransaction(row.signedTransaction);
}

/** Read-only reconciliation remains available while live payouts are paused. */
export function reconciliationClient() {
  const host = process.env.TRON_FULL_HOST || "https://api.trongrid.io";
  if (new URL(host).protocol !== "https:") throw new Error("TRON_FULL_HOST must use HTTPS.");
  return new TronWeb({ fullHost: host, ...(process.env.TRON_PRO_API_KEY ? { headers: { "TRON-PRO-API-KEY": process.env.TRON_PRO_API_KEY } } : {}) });
}

export class ReconciliationError extends Error {
  constructor(message: string, public statusCode: number) { super(message); }
}
const unresolvedReason = "The blockchain result remains unresolved. Funds remain reserved; no refund was made.";
const executionFailures = new Set(["REVERT", "OUT_OF_ENERGY", "OUT_OF_TIME", "ILLEGAL_OPERATION", "BAD_JUMP_DESTINATION", "OUT_OF_MEMORY", "PRECOMPILED_CONTRACT", "STACK_TOO_SMALL", "STACK_TOO_LARGE", "JVM_STACK_OVER_FLOW", "TRANSFER_FAILED", "INVALID_CODE"]);

export async function reconcileProWithdrawal(id: mongoose.Types.ObjectId, admin: mongoose.Types.ObjectId, clientFactory = reconciliationClient) {
  const initial = await Transaction.findOne({ type: "withdrawal", _id: id }).readConcern("majority").select("+signedTransaction").lean();
  if (!initial) throw new ReconciliationError("Withdrawal not found.", 404);
  if (!["REVIEW", "COMPLETED", "FAILED"].includes(initial.status)) {
    throw new ReconciliationError("Only withdrawals under review can be reconciled.", 409);
  }
  let status: "REVIEW" | "COMPLETED" | "FAILED" = "REVIEW";
  let reason = unresolvedReason;
  if (initial.status === "REVIEW" && initial.transactionId && initial.signedTransaction && initial.address) {
    try {
      const sender = initial.senderAddress;
      if (!sender || initial.signedTransaction.txID !== initial.transactionId) throw new Error("Missing payout identity");
      assertPayoutTransaction(initial.signedTransaction, initial.address, initial.units, sender);
      const tron = clientFactory();
      const [transaction, info] = await Promise.all([
        tron.trx.getConfirmedTransaction(initial.transactionId),
        tron.trx.getTransactionInfo(initial.transactionId),
      ]);
      if (transaction.txID !== initial.transactionId || info.id !== initial.transactionId) throw new Error("Receipt identity mismatch");
      assertPayoutTransaction(transaction, initial.address, initial.units, sender);
      const result = transaction.ret?.[0]?.contractRet;
      if (result === "SUCCESS" && transferConfirmed(info, initial.address, initial.units, sender)) {
        status = "COMPLETED";
        reason = "Confirmed the exact USDT transfer on TRON. Reserved funds were paid; no refund was made.";
      } else if (info.result === "FAILED" && result && executionFailures.has(result) && info.receipt?.result === result) {
        status = "FAILED";
        reason = "Confirmed on-chain execution failure; the exact withdrawal amount was refunded.";
      }
    } catch {
      // Missing receipts, timeouts, mismatched evidence and expiry never prove failure.
      reason = unresolvedReason;
    }
  }
  let output: any;
  let idempotent = false;
  await mongoose.connection.transaction(async session => {
    const current = await Transaction.findOne({ type: "withdrawal", _id: id }).session(session).lean();
    if (!current) throw new ReconciliationError("Withdrawal not found.", 404);
    const previousStatus = current.status;
    idempotent = ["COMPLETED", "FAILED"].includes(current.status);
    if (idempotent) {
      output = current;
    } else {
      if (current.status !== "REVIEW" || current.transactionId !== initial.transactionId ||
          current.units !== initial.units || current.address !== initial.address ||
          String(current.userId) !== String(initial.userId) || current.senderAddress !== initial.senderAddress) {
        throw new ReconciliationError("Withdrawal changed. Refresh before reconciling.", 409);
      }
      output = await Transaction.findOneAndUpdate({ type: "withdrawal", _id: id, status: "REVIEW", transactionId: initial.transactionId },
        { $set: { status, lastError: reason, ...(status === "REVIEW" ? {} : { completedAt: new Date() }) } },
        { new: true, session }).lean();
      if (!output) throw new ReconciliationError("Withdrawal changed. Refresh before reconciling.", 409);
      if (status === "FAILED") {
        const field = "proBalanceUnits";
        const refund = await User.updateOne({ _id: current.userId, [field]: { $lte: Number.MAX_SAFE_INTEGER - current.units } },
          { $inc: { [field]: current.units } }, { session });
        if (refund.matchedCount !== 1) throw new Error("Refund account unavailable.");
      }
    }
    await AuditLog.create([{ userId: current.userId, admin, action: "Pro Withdrawal Reconciled", targetId: id,
      targetType: "ProWithdrawal", details: { withdrawalId: id, requestId: current.requestId, previousStatus,
        newStatus: output.status, transactionId: current.transactionId, units: current.units,
        result: idempotent ? "ALREADY_RESOLVED" : status === "REVIEW" ? "UNRESOLVED" : status,
        reason: idempotent ? "Already resolved; balance unchanged." : reason } }], { session });
  }, { writeConcern: { w: "majority" }, readConcern: { level: "snapshot" } });
  return { withdrawal: output, idempotent, message: idempotent ? "Already resolved; balance unchanged." : reason };
}

let working = false;
let creditCursor: mongoose.Types.ObjectId | undefined;
export async function runProPayoutWorker() {
  if (working) return;
  working = true;
  try {
    const credits = await Trade.find({ tradeOrigin: "copy", feeStatus: "collected", proTraderCreditStatus: "pending", ...(creditCursor ? { _id: { $gt: creditCursor } } : {}) }).sort({ _id: 1 }).limit(100).select("_id").lean();
    for (const trade of credits) {
      try { await creditProEarning(trade._id); } catch { console.error("[Pro payouts] Credit requires retry", String(trade._id)); }
    }
    creditCursor = credits.length === 100 ? credits[credits.length - 1]!._id : undefined;
    const rows = await Transaction.find({ type: "withdrawal", status: { $in: ["QUEUED", "SIGNED"] } }).sort({ updatedAt: 1 }).limit(20).select("_id").lean();
    for (const row of rows) {
      try { await processProWithdrawal(row._id); }
      catch {
        await Transaction.updateOne({ type: "withdrawal", _id: row._id, status: { $in: ["QUEUED", "SIGNED"] } }, { $set: { lastError: "Payout awaiting retry or confirmation." } });
      }
    }
  } finally { working = false; }
}
export async function initializeProFinance() {
  // Unique indexes must exist before accepting requests, including production with autoIndex off.
  await Transaction.createIndexes();
  const timer = setInterval(() => { void runProPayoutWorker().catch(() => console.error("[Pro payouts] Worker unavailable")); }, 15_000);
  timer.unref();
}
