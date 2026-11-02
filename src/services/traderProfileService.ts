import mongoose from "mongoose";
import User from "../models/userModel.js";
import { Trade } from "../models/tradeModel.js";
import { CopySubscription } from "../models/copySubscriptionModel.js";
import { RankAward } from "../models/rankModel.js";
import { RANKS, performance, qualifies, retainedLevel } from "./rankRules.js";

export async function getCopiers(proTraderId: mongoose.Types.ObjectId, now = new Date()) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const subscriptions = await CopySubscription.find({ proTraderId, active: true })
    .populate("copierId", "firstName lastName traderID profilePhoto status")
    .populate("exchangeConnectionId", "exchange label isActive balanceUsdt balanceCheckedAt")
    .sort({ startedAt: -1 }).lean();
  const sources = await Trade.find({ userId: proTraderId, tradeOrigin: "pro" }).select("_id").lean();
  const stats = await Trade.aggregate([
    { $match: { sourceTradeId: { $in: sources.map(t => t._id) }, tradeOrigin: "copy" } },
    { $group: {
      _id: "$userId", copiedTrades: { $sum: 1 },
      monthlyTrades: { $sum: { $cond: [{ $and: [{ $gte: ["$createdAt", monthStart] }, { $lte: ["$createdAt", now] }, { $in: ["$status", ["filled", "closed"]] }] }, 1, 0] } },
      monthlyFees: { $sum: { $cond: [{ $and: [{ $gte: ["$closedAt", monthStart] }, { $lte: ["$closedAt", now] }, { $ne: ["$feeStatus", "waived"] }] }, { $convert: { input: "$platformFee", to: "double", onError: 0, onNull: 0 } }, 0] } },
      realizedPnl: { $sum: { $convert: { input: "$realizedPnl", to: "double", onError: 0, onNull: 0 } } },
    } },
  ]);
  const byUser = new Map(stats.map(s => [String(s._id), s]));
  return subscriptions.map(subscription => {
    const copier = subscription.copierId as unknown as { _id: mongoose.Types.ObjectId; status: string } | null;
    const connection = subscription.exchangeConnectionId as unknown as { isActive: boolean; balanceUsdt: number | null; balanceCheckedAt: Date | null; exchange: string; label: string } | null;
    const stat = byUser.get(String(copier?._id)) ?? { copiedTrades: 0, monthlyTrades: 0, monthlyFees: 0, realizedPnl: 0 };
    const balanceFresh = !!connection?.balanceCheckedAt && connection.balanceCheckedAt.getTime() >= now.getTime() - 86400_000;
    const balanceQualified = balanceFresh && !!connection?.isActive && Number(connection.balanceUsdt) >= 100;
    return {
      _id: subscription._id, copier, startedAt: subscription.startedAt, allocation: subscription.allocation,
      exchange: connection?.exchange, label: connection?.label,
      copiedTrades: stat.copiedTrades, monthlyTrades: stat.monthlyTrades, monthlyFees: stat.monthlyFees, realizedPnl: stat.realizedPnl,
      balanceQualified, balanceFresh,
      rankActive: copier?.status === "active" && balanceQualified && stat.monthlyTrades >= 15 && stat.monthlyFees >= 10,
    };
  });
}

export async function traderProfile(proTraderId: mongoose.Types.ObjectId, viewerId?: mongoose.Types.ObjectId) {
  const user = await User.findOne({ _id: proTraderId, role: "ProTrader", status: "active" }).select("firstName lastName traderID profilePhoto createdAt").lean();
  if (!user) return null;
  const [copiers, closed, activeTrades, subscription] = await Promise.all([
    getCopiers(proTraderId),
    Trade.find({ userId: proTraderId, tradeOrigin: "pro", status: "closed" }).select("tradeResult realizedPnl rawOrderResponse closedAt").sort({ closedAt: 1, _id: 1 }).lean(),
    Trade.countDocuments({ userId: proTraderId, tradeOrigin: "pro", status: { $in: ["pending", "filled"] } }),
    viewerId ? CopySubscription.findOne({ copierId: viewerId, proTraderId, active: true }).lean() : Promise.resolve(null),
  ]);
  const metrics = { ...performance(closed), activeCopiers: copiers.filter(c => c.rankActive).length };
  for (const rank of RANKS.slice(1)) {
    if (qualifies(metrics, rank)) {
      try { await RankAward.updateOne({ userId: proTraderId, level: rank.level }, { $setOnInsert: { bonus: rank.bonus, qualifiedMetrics: metrics, status: "pending" } }, { upsert: true }); }
      catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    }
  }
  const awards = await RankAward.find({ userId: proTraderId }).select("level bonus status mode createdAt verifiedAt").sort({ level: 1 }).lean();
  const highestLevel = Math.max(0, ...awards.map(a => a.level));
  const level = retainedLevel(awards.map(a => a.level), metrics.activeCopiers);
  const nextRank = RANKS.find(r => r.level > highestLevel) ?? null;
  return {
    ...user, metrics, subscribers: copiers.length, activeTrades,
    realizedPnl: closed.reduce((sum, t) => sum + (Number(t.realizedPnl) || 0), 0),
    rank: RANKS[level], highestLevel, nextRank, awards, subscription,
    progress: nextRank ? {
      copiersRemaining: Math.max(0, nextRank.copiers - metrics.activeCopiers),
      tradesRemaining: Math.max(0, nextRank.trades - metrics.closedTrades),
      winRateMet: metrics.winRate >= nextRank.winRate,
      drawdownMet: metrics.maxDrawdown !== null && metrics.maxDrawdown < nextRank.maxDrawdown,
    } : null,
  };
}

export function initializeTraderRanks() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for await (const user of User.find({ role: "ProTrader", status: "active" }).select("_id").lean().cursor()) {
        await traderProfile(user._id);
      }
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick().catch(error => console.error("[ranks]", error)), 5 * 60_000);
  timer.unref();
  void tick().catch(error => console.error("[ranks]", error));
}
