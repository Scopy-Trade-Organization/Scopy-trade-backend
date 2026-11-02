import mongoose from "mongoose";
import { CopyExecution, CopyExecutionLock, CopyNotification, CopySubscription } from "../models/copySubscriptionModel.js";
import { Trade } from "../models/tradeModel.js";
import User from "../models/userModel.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import { executeTrade } from "./tradeExecutionService.js";
import { getExchangeBalance } from "./tradeService.js";
import { decryptCredentials } from "./exchangeConnectionService.js";
import { queueCopyFailureEmail } from "./emailService.js";
import { ExchangeId } from "../types/index.js";

export async function refreshConnectionBalance(connectionId: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId) {
  const connection = await ExchangeConnection.findOne({ _id: connectionId, userId, isActive: true }).lean();
  if (!connection?.encryptedApiKey || !connection.encryptedApiSecret) throw new Error("Your selected exchange is disconnected. Reconnect it in Exchange Settings.");
  const credentials = decryptCredentials({
    exchange: connection.exchange as ExchangeId, apiKey: connection.encryptedApiKey,
    apiSecret: connection.encryptedApiSecret,
    ...(connection.encryptedPassphrase ? { passphrase: connection.encryptedPassphrase } : {}),
  });
  const result = await getExchangeBalance(connection.exchange as ExchangeId, credentials);
  const balance = Number(result.totalUsdtEquivalent);
  if (!Number.isFinite(balance) || balance < 0) throw new Error("The exchange returned an unavailable balance. Check your exchange account.");
  await ExchangeConnection.updateOne({ _id: connectionId }, { $set: { balanceUsdt: balance, balanceCheckedAt: new Date() } });
  return balance;
}

export async function enqueueAutomaticCopies(sourceTradeId: string) {
  const source = await Trade.findOne({ _id: sourceTradeId, tradeOrigin: "pro" }).lean();
  if (!source || source.copyFanoutAt) return;
  const subscriptions = await CopySubscription.find({ proTraderId: source.userId, active: true, startedAt: { $lte: source.createdAt } }).lean();
  if (subscriptions.length) await CopyExecution.bulkWrite(subscriptions.map(subscription => ({ updateOne: {
    filter: { sourceTradeId: source._id, exchangeConnectionId: subscription.exchangeConnectionId },
    update: { $setOnInsert: { sourceTradeId: source._id, subscriptionId: subscription._id, copierId: subscription.copierId, exchangeConnectionId: subscription.exchangeConnectionId, status: "queued" } },
    upsert: true,
  } })), { ordered: false });
  await Trade.updateOne({ _id: source._id }, { $set: { copyFanoutAt: new Date() } });
}

async function notifyFailure(job: { _id: mongoose.Types.ObjectId; copierId: mongoose.Types.ObjectId; sourceTradeId: mongoose.Types.ObjectId }, reason: string) {
  const source = await Trade.findById(job.sourceTradeId).select("pair userId").populate("userId", "firstName lastName").lean();
  const pro = source?.userId as unknown as { firstName?: string; lastName?: string };
  const title = `Automatic copy failed${source ? `: ${source.pair}` : ""}`;
  const message = `${pro?.firstName || "Your pro trader"}${pro?.lastName ? ` ${pro.lastName}` : ""}: ${reason}`;
  const notification = await CopyNotification.updateOne({ executionId: job._id }, { $setOnInsert: { userId: job.copierId, title, message } }, { upsert: true });
  if (notification.upsertedCount) queueCopyFailureEmail(job.copierId, title, message);
  await CopyExecution.updateOne({ _id: job._id }, { $set: { failureNotifiedAt: new Date() } });
}

// Only user-safe reasons enter notifications; raw exchange errors can contain signed URLs.
function safeFailure(result: { status: number; body: Record<string, any> }) {
  const detail = String(result.body.detail || "").toLowerCase();
  if (/insufficient|not enough|available balance|margin is not enough/.test(detail)) return "The exchange reported insufficient funds or margin. Fund your account or reduce your allocation.";
  if (/permission|api.?key|signature|unauthorized|authentication/.test(detail)) return "The exchange rejected your API credentials or trading permissions. Check your connection in Exchange Settings.";
  if (/minimum|min.?notional|lot.?size|quantity|precision/.test(detail)) return "The order does not meet this exchange’s size or precision requirements. Review your allocation and exchange limits.";
  if (result.status === 500) return "The platform could not complete this copy. Check your exchange orders before taking further action.";
  if (result.status === 502) return "The exchange could not confirm this order. Check your balance, trading permissions and exchange order history before taking further action.";
  return String(result.body.message || "This trade could not be copied.");
}

let running = false;
export async function drainCopyQueue(dependencies: { executeTrade?: typeof executeTrade; refreshConnectionBalance?: typeof refreshConnectionBalance } = {}) {
  if (running) return;
  running = true;
  try {
    // Recover interrupted work conservatively: never blindly repeat an exchange order.
    const interrupted = await CopyExecution.find({ status: "processing", startedAt: { $lt: new Date(Date.now() - 10 * 60_000) } }).lean();
    for (const job of interrupted) {
      const existing = await Trade.exists({ sourceTradeId: job.sourceTradeId, exchangeConnectionId: job.exchangeConnectionId });
      const reason = "Order confirmation was interrupted. Check your exchange order history and contact support before retrying.";
      await CopyExecution.updateOne({ _id: job._id, status: "processing" }, { $set: { status: existing ? "completed" : "failed", reason: existing ? null : reason, completedAt: new Date() } });
      if (!existing) await notifyFailure(job, reason);
    }
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, async () => {
      for (let i = 0; i < 25; i++) {
        const job = await CopyExecution.findOneAndUpdate({ status: "queued", availableAt: { $lte: new Date() } }, { $set: { status: "processing", startedAt: new Date() } }, { new: true, sort: { createdAt: 1 } }).lean();
        if (!job) break;
        let locked = false, retainLock = false;
        try {
          const subscription = await CopySubscription.findOne({ _id: job.subscriptionId, active: true }).lean();
          const source = await Trade.findById(job.sourceTradeId).select("userId status createdAt").lean();
          if (!subscription || !source || subscription.startedAt > source.createdAt) {
            await CopyExecution.updateOne({ _id: job._id }, { $set: { status: "skipped", reason: "Subscription was stopped before execution.", completedAt: new Date() } });
            continue;
          }
          if (!await User.exists({ _id: job.copierId, role: "CopyTrader", status: "active" })) throw new Error("Your account is currently unavailable for copying. Contact support.");
          if (!await User.exists({ _id: source.userId, role: "ProTrader", status: "active" })) throw new Error("This pro trader is currently unavailable for copying.");
          if (!["pending", "filled"].includes(source.status)) throw new Error("The pro trader's position closed before your copy could be opened.");
          if (await Trade.exists({ sourceTradeId: job.sourceTradeId, exchangeConnectionId: job.exchangeConnectionId })) {
            await CopyExecution.updateOne({ _id: job._id }, { $set: { status: "completed", completedAt: new Date() } });
            continue;
          }
          try {
            await CopyExecutionLock.create({ connectionId: job.exchangeConnectionId, executionId: job._id });
            locked = true;
          } catch (error) {
            if ((error as { code?: number }).code !== 11000) throw error;
            const lock = await CopyExecutionLock.findOne({ connectionId: job.exchangeConnectionId }).lean();
            if (lock && await CopyExecution.exists({ _id: lock.executionId, status: "processing" })) {
              await CopyExecution.updateOne({ _id: job._id }, { $set: { status: "queued", startedAt: null, availableAt: new Date(Date.now() + 15_000) } });
              continue;
            }
            throw new Error("Another automatic order is processing or needs review on this exchange account. Check your order history or contact support.");
          }
          let balance: number;
          try { balance = await (dependencies.refreshConnectionBalance ?? refreshConnectionBalance)(job.exchangeConnectionId, job.copierId); }
          catch { throw new Error("Your exchange balance could not be verified. Check your connection and API permissions in Exchange Settings."); }
          if (balance < subscription.allocation) throw new Error(`Insufficient connected balance: this subscription requires ${subscription.allocation} USDT. Reduce the allocation or fund your account.`);
          // Recheck immediately before execution so stopping a queued subscription takes effect.
          if (!await CopySubscription.exists({ _id: job.subscriptionId, active: true, startedAt: subscription.startedAt })) {
            await CopyExecution.updateOne({ _id: job._id }, { $set: { status: "skipped", completedAt: new Date() } });
            continue;
          }
          const result = await (dependencies.executeTrade ?? executeTrade)(job.copierId, { sourceTradeId: String(job.sourceTradeId), exchangeConnectionId: String(job.exchangeConnectionId), balance: subscription.allocation }, false);
          retainLock = result.body.code === "ORDER_REVIEW_REQUIRED";
          if (result.status !== 201) throw new Error(safeFailure(result));
          await CopyExecution.updateOne({ _id: job._id }, { $set: { status: "completed", completedAt: new Date() } });
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Automatic copying failed. Contact support.";
          await CopyExecution.updateOne({ _id: job._id }, { $set: { status: "failed", reason, completedAt: new Date() } });
          await notifyFailure(job, reason);
        } finally {
          if (locked && !retainLock) await CopyExecutionLock.deleteOne({ connectionId: job.exchangeConnectionId, executionId: job._id });
        }
      }
    }));
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") console.error("[automaticCopy] worker", outcome.reason);
    }
    // Notification persistence can be retried without ever retrying an order.
    const failures = await CopyExecution.find({ status: "failed", reason: { $ne: null }, failureNotifiedAt: null }).limit(500).lean();
    for (const job of failures) await notifyFailure(job, job.reason!);
  } finally { running = false; }
}

export function triggerAutomaticCopies(sourceTradeId: string): void {
  setImmediate(() => void enqueueAutomaticCopies(sourceTradeId).then(() => drainCopyQueue()).catch(error => console.error("[automaticCopy]", error)));
}

export function initializeAutomaticCopying() {
  const recover = async () => {
    // Recover fan-out missed between persisting a pro order and scheduling its helper.
    const sources = await Trade.find({ tradeOrigin: "pro", copyFanoutAt: null }).sort({ createdAt: 1 }).select("_id").limit(500).lean();
    for (const source of sources) await enqueueAutomaticCopies(String(source._id));
    await drainCopyQueue();
  };
  let recovering = false;
  const tick = () => {
    if (recovering) return;
    recovering = true;
    void recover().catch(error => console.error("[automaticCopy] recovery", error)).finally(() => { recovering = false; });
  };
  tick();
  const timer = setInterval(tick, 15_000);
  timer.unref();
  // Keep connected-balance evidence fresh for rank eligibility.
  let refreshing = false;
  const refreshBalances = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const subscriptions = await CopySubscription.find({ active: true }).distinct("exchangeConnectionId");
      const connections = await ExchangeConnection.find({ _id: { $in: subscriptions }, isActive: true, $or: [{ balanceCheckedAt: null }, { balanceCheckedAt: { $lt: new Date(Date.now() - 15 * 60_000) } }] }).select("_id userId").limit(100).lean();
      for (let i = 0; i < connections.length; i += 5) await Promise.allSettled(connections.slice(i, i + 5).map(row => refreshConnectionBalance(row._id, row.userId)));
    } finally { refreshing = false; }
  };
  const balanceTimer = setInterval(() => void refreshBalances().catch(error => console.error("[automaticCopy] balances", error)), 60_000);
  balanceTimer.unref();
}
