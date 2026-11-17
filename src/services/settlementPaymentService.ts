import { Transaction } from "../models/transactionModel.js";
import axios from "axios";
import mongoose from "mongoose";
import { TronWeb, Trx } from "tronweb";
import { Trade } from "../models/tradeModel.js";
import { Notification } from "../models/notificationModel.js";
import User from "../models/userModel.js";
import { usdtUnits, formatUsdt } from "../helpers/usdt.js";
import { getProfitShareSummary } from "./profitSharingService.js";
import { MAINNET_USDT, TRANSFER_TOPIC, creditProEarning } from "./proFinanceService.js";
import { sendEmail } from "./emailService.js";

export function settlementWallet() {
  const address = process.env.SYSTEM_WALLET_ADDRESS?.trim();
  if (!address || !TronWeb.isAddress(address)) throw new Error("Configure a valid SYSTEM_WALLET_ADDRESS.");
  if ((process.env.SYSTEM_WALLET_NETWORK || "TRON") !== "TRON") throw new Error("Settlement requires TRON.");
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
        await Transaction.create([{ type: "settlement",
          _id: id, userId, memo: `SCOPY-${batchId}`,
          tradeIds: trades.map(trade => trade._id), units,
          address, status: "AWAITING_PAYMENT",
        }], { session });
        await Trade.updateMany({ _id: { $in: trades.map(trade => trade._id) }, feeStatus: { $in: ["pending", "failed"] } }, {
          $set: { feeStatus: "processing", settlementBatchId: batchId, settlementStartedAt: new Date() },
        }, { session });
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    invoice = await Transaction.findOne({ type: "settlement", userId, status: "AWAITING_PAYMENT" }).lean();
  }
  if (invoice) await Notification.updateOne({ settlementId: invoice._id, kind: "settlement_due" }, {
    $setOnInsert: { userId, title: "Profit-share settlement due", message: `Log into your dashboard and pay ${formatUsdt(invoice.units)} USDT on TRON to ${invoice.address}. Include memo ${invoice.memo}. New copied trades are paused until payment is confirmed.` },
  }, { upsert: true });
  return invoice;
}

function api() {
  const host = process.env.SETTLEMENT_TRON_HOST || "https://api.trongrid.io";
  // Incoming settlement receipts must always be mainnet; payouts have separate configuration.
  if (host !== "https://api.trongrid.io") throw new Error("Settlement verification requires the mainnet TronGrid endpoint.");
  return axios.create({ baseURL: host, timeout: 15_000, headers: process.env.TRON_PRO_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRON_PRO_API_KEY } : {} });
}

const hex = (address: string) => TronWeb.address.toHex(address).slice(2).toLowerCase();
export const ownershipMessage = (id: string) => `ScopyTrade settlement ${id}`;

/** Pure receipt validation, shared by automatic and hash-based verification. */
export function validateSettlementReceipt(invoice: any, hash: string, tx: any, info: any, signature?: string) {
  if (tx?.txID?.toLowerCase() !== hash || info?.id?.toLowerCase() !== hash ||
      info?.receipt?.result !== "SUCCESS" || info?.result === "FAILED" ||
      !Number.isSafeInteger(info?.blockNumber) || info.blockNumber < 1 ||
      !Number.isFinite(info?.blockTimeStamp) || info.blockTimeStamp < new Date(invoice.createdAt).getTime()) {
    throw new Error("Payment is not a successful confirmed transfer made after this invoice was created.");
  }
  const contracts = tx?.raw_data?.contract;
  const value = contracts?.[0]?.parameter?.value;
  if (contracts?.length !== 1 || contracts[0]?.type !== "TriggerSmartContract" ||
      String(value?.contract_address).toLowerCase() !== TronWeb.address.toHex(MAINNET_USDT).toLowerCase() ||
      !/^(41)[0-9a-f]{40}$/i.test(value?.owner_address || "")) throw new Error("Expected a direct mainnet USDT transfer.");
  const sender = TronWeb.address.fromHex(value.owner_address);
  const memoHex = tx?.raw_data?.data;
  const memo = typeof memoHex === "string" && /^(?:[a-f0-9]{2})+$/i.test(memoHex) ? Buffer.from(memoHex, "hex").toString("utf8") : "";
  if (memo !== invoice.memo) {
    // Never let a hash override another invoice's memo.
    if (memo) throw new Error("Payment memo belongs to a different invoice.");
    let signer = "";
    try { signer = signature ? Trx.verifyMessageV2(ownershipMessage(String(invoice._id)), signature) : ""; } catch { /* invalid signature */ }
    if (signer !== sender) throw new Error("Payment has no memo. Sign the invoice ownership message with the sending wallet and provide its signature, or contact support.");
  }
  const expected = "a9059cbb" + hex(invoice.address).padStart(64, "0") + BigInt(invoice.units).toString(16).padStart(64, "0");
  if (String(value.data).toLowerCase() !== expected || Number(value.call_value || 0) !== 0) throw new Error("Payment recipient or amount does not match the invoice. Send the exact USDT amount.");
  const matched = info.log?.some((log: any) =>
    String(log.address).toLowerCase().replace(/^41(?=[a-f0-9]{40}$)/, "") === hex(MAINNET_USDT) &&
    log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC &&
    log.topics?.[1]?.toLowerCase() === hex(sender).padStart(64, "0") &&
    log.topics?.[2]?.toLowerCase() === hex(invoice.address).padStart(64, "0") &&
    /^[a-f0-9]{64}$/i.test(log.data || "") && BigInt("0x" + log.data) === BigInt(invoice.units));
  if (!matched) throw new Error("Confirmed receipt does not contain the expected USDT transfer.");
  return sender;
}

export async function verifySettlement(userId: mongoose.Types.ObjectId, id: string, hash: string, signature?: string, clientFactory = api) {
  if (!mongoose.isValidObjectId(id) || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error("Enter a valid settlement ID and 64-character transaction hash.");
  hash = hash.toLowerCase();
  const invoice = await Transaction.findOne({ type: "settlement", _id: id, userId }).lean();
  if (!invoice) throw new Error("Settlement not found.");
  if (invoice.status === "COMPLETED") {
    if (invoice.transactionId !== hash) throw new Error("This invoice was paid with a different transaction.");
    return invoice;
  }
  if (invoice.status !== "AWAITING_PAYMENT" || !invoice.units || !invoice.memo) throw new Error("Invoice requires operator review.");
  const client = clientFactory();
  // Solidity endpoints return only solidified transactions; a broadcast response is insufficient.
  const [{ data: tx }, { data: info }] = await Promise.all([
    client.post("/walletsolidity/gettransactionbyid", { value: hash }),
    client.post("/walletsolidity/gettransactioninfobyid", { value: hash }),
  ]);
  const senderAddress = validateSettlementReceipt(invoice, hash, tx, info, signature);
  await mongoose.connection.transaction(async session => {
    const paid = await Transaction.findOneAndUpdate({ type: "settlement", _id: id, userId, status: "AWAITING_PAYMENT" }, {
      $set: { status: "COMPLETED", transactionId: hash, senderAddress, completedAt: new Date(), lastError: null },
    }, { session, new: true });
    if (!paid) return;
    await Trade.updateMany({ _id: { $in: paid.tradeIds }, settlementBatchId: String(paid._id), feeStatus: "processing" }, {
      $set: { feeStatus: "collected", settlementTransactionId: hash, settlementBlockchainTransactionId: hash, settlementNetwork: "TRON", settlementAddress: paid.address, settlementCompletedAt: paid.completedAt },
    }, { session });
    await Notification.create([{ userId, settlementId: paid._id, kind: "settlement_paid", title: "Settlement confirmed", message: `Your ${formatUsdt(paid.units)} USDT settlement has been confirmed.` }], { session });
  });
  for (const tradeId of invoice.tradeIds) {
    await creditProEarning(tradeId).catch(() => console.error("[Settlement] Pro credit requires retry", String(tradeId)));
  }
  const result = await Transaction.findOne({ type: "settlement", _id: id, userId }).lean();
  if (result?.transactionId !== hash) throw new Error("This invoice was already paid with a different transaction. Contact support about the additional payment.");
  return result;
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
        const text = `${notification.message}\nDashboard: ${url}\nPay the exact amount. Keep TRX in your sending wallet for network fees. Never share your private key.`;
        const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        await sendEmail({ to: user.email, subject: notification.title, text, html: `<p style="white-space:pre-wrap">${escaped}</p>` });
      }
      await Notification.updateOne({ _id: notification._id }, { $set: { emailSentAt: new Date(), emailLastError: null } });
    } catch {
      await Notification.updateOne({ _id: notification._id }, { $set: { emailLastError: "Email delivery failed; retry scheduled." } });
    }
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
      try {
        let fingerprint: string | undefined;
        // Oldest-first, bounded pages. Hash verification is available if history exceeds this scan.
        for (let page = 0; page < 5; page++) {
          const { data } = await api().get(`/v1/accounts/${invoice.address}/transactions/trc20`, { params: {
            only_confirmed: true, only_to: true, contract_address: MAINNET_USDT, min_timestamp: invoice.createdAt.getTime(),
            order_by: "block_timestamp,asc", limit: 200, ...(fingerprint ? { fingerprint } : {}),
          } });
          for (const item of data.data || []) {
            if (item.to !== invoice.address || item.value !== String(invoice.units)) continue;
            try { await verifySettlement(invoice.userId, String(invoice._id), item.transaction_id); } catch { continue; }
            break;
          }
          if (await Transaction.exists({ type: "settlement", _id: invoice._id, status: "COMPLETED" })) break;
          fingerprint = data.meta?.fingerprint;
          if (!fingerprint) break;
        }
      } catch { console.error("[Settlement] Automatic verification unavailable; retry scheduled"); }
      await Transaction.updateOne({ type: "settlement", _id: invoice._id }, { $set: { updatedAt: new Date() } });
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
