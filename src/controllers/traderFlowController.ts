import { Request, Response } from "express";
import mongoose from "mongoose";
import User from "../models/userModel.js";
import { CopySubscription, CopyNotification } from "../models/copySubscriptionModel.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import { RankAward } from "../models/rankModel.js";
import AuditLog from "../models/auditLogModel.js";
import { traderProfile, getCopiers } from "../services/traderProfileService.js";
import { refreshConnectionBalance } from "../services/automaticCopyService.js";
import { RANKS } from "../services/rankRules.js";
import { balanceField, payoutMode } from "../services/proFinanceService.js";
import { SUPPORTED_TRADE_EXCHANGES } from "../constants.js";

const handler = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try { return await fn(req, res); }
  catch (error) {
    console.error("[traderFlow]", error);
    return res.status(500).json({ success: false, message: "Unable to complete this request. Please try again." });
  }
};
function page(req: Request) { return Math.max(1, Math.min(10000, Number.parseInt(String(req.query.page || 1), 10) || 1)); }

export const discoverTraders = handler(async (req, res) => {
  const current = page(req), limit = 12;
  const filter = { role: "ProTrader", status: "active" };
  const [users, total] = await Promise.all([
    User.find(filter).select("_id").sort({ createdAt: -1, _id: -1 }).skip((current - 1) * limit).limit(limit).lean(),
    User.countDocuments(filter),
  ]);
  const traders = await Promise.all(users.map(user => traderProfile(user._id, req.user as mongoose.Types.ObjectId)));
  return res.json({ success: true, traders: traders.filter(Boolean), page: current, pages: Math.max(1, Math.ceil(total / limit)) });
});

export const getTraderProfile = handler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.traderId)) return res.status(400).json({ success: false, message: "Invalid trader ID." });
  const trader = await traderProfile(new mongoose.Types.ObjectId(String(req.params.traderId)), req.user as mongoose.Types.ObjectId);
  return res.status(trader ? 200 : 404).json({ success: !!trader, trader, message: trader ? undefined : "Trader not found." });
});

export const startCopying = handler(async (req, res) => {
  const { exchangeConnectionId, allocation } = req.body;
  if (!mongoose.isValidObjectId(req.params.traderId) || !mongoose.isValidObjectId(exchangeConnectionId)) return res.status(400).json({ success: false, message: "Select a trader and an exchange account." });
  if (typeof allocation !== "number" || !Number.isFinite(allocation) || allocation < 1 || allocation > 1e9) return res.status(400).json({ success: false, message: "Allocation must be a positive USDT amount of at least 1." });
  const proTraderId = new mongoose.Types.ObjectId(String(req.params.traderId));
  if (String(proTraderId) === String(req.user) || !await User.exists({ _id: proTraderId, role: "ProTrader", status: "active" })) return res.status(404).json({ success: false, message: "This pro trader is unavailable." });
  const existing = await CopySubscription.findOne({ copierId: req.user, proTraderId, active: true }).lean();
  if (existing) return res.status(409).json({ success: false, message: "You already copy this trader. Stop copying before changing the account or allocation." });
  const connection = await ExchangeConnection.findOne({ _id: exchangeConnectionId, userId: req.user, isActive: true }).lean();
  if (!connection || !SUPPORTED_TRADE_EXCHANGES.includes(connection.exchange as typeof SUPPORTED_TRADE_EXCHANGES[number])) return res.status(422).json({ success: false, message: "Select an active exchange that supports trading." });
  let balance: number;
  try { balance = await refreshConnectionBalance(connection._id, req.user as mongoose.Types.ObjectId); }
  catch { return res.status(422).json({ success: false, message: "Could not verify your exchange balance. Check your connection and API permissions." }); }
  if (allocation > balance) return res.status(422).json({ success: false, message: "Allocation exceeds your connected exchange balance." });
  // An atomic predicate prevents concurrent requests from changing an active subscription.
  let subscription;
  try {
    subscription = await CopySubscription.findOneAndUpdate({ copierId: req.user, proTraderId, active: false }, { $set: { exchangeConnectionId, allocation, active: true, startedAt: new Date(), stoppedAt: null } }, { upsert: true, new: true, runValidators: true });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return res.status(409).json({ success: false, message: "You already copy this trader." });
    throw error;
  }
  return res.status(201).json({ success: true, subscription, message: "Copying enabled for future trades. Existing pro positions are not copied retroactively." });
});

export const stopCopying = handler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.traderId)) return res.status(400).json({ success: false, message: "Invalid trader ID." });
  await CopySubscription.updateOne({ copierId: req.user, proTraderId: req.params.traderId, active: true }, { $set: { active: false, stoppedAt: new Date() } });
  return res.json({ success: true, message: "Copying stopped. Existing positions remain monitored until they close." });
});

export const mySubscriptions = handler(async (req, res) => {
  const subscriptions = await CopySubscription.find({ copierId: req.user, active: true })
    .populate("proTraderId", "firstName lastName traderID profilePhoto status")
    .populate("exchangeConnectionId", "exchange label isActive").sort({ startedAt: -1 }).lean();
  return res.json({ success: true, subscriptions });
});

export const myCopiers = handler(async (req, res) => res.json({ success: true, copiers: await getCopiers(req.user as mongoose.Types.ObjectId) }));
export const myRanks = handler(async (req, res) => res.json({ success: true, ranks: RANKS, trader: await traderProfile(req.user as mongoose.Types.ObjectId) }));
export const notifications = handler(async (req, res) => {
  const current = page(req), limit = 20;
  const [rows, total, unread] = await Promise.all([
    CopyNotification.find({ userId: req.user }).sort({ createdAt: -1 }).skip((current - 1) * limit).limit(limit).lean(),
    CopyNotification.countDocuments({ userId: req.user }), CopyNotification.countDocuments({ userId: req.user, readAt: null }),
  ]);
  return res.json({ success: true, notifications: rows, unread, page: current, pages: Math.max(1, Math.ceil(total / limit)) });
});
export const readNotification = handler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid notification ID." });
  await CopyNotification.updateOne({ _id: req.params.id, userId: req.user, readAt: null }, { $set: { readAt: new Date() } });
  return res.json({ success: true });
});

export const listRankAwards = handler(async (req, res) => {
  const awards = await RankAward.find({ status: "pending" }).populate("userId", "firstName lastName traderID").sort({ createdAt: 1 }).limit(100).lean();
  return res.json({ success: true, awards });
});
export const verifyRankAward = handler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid award ID." });
  if (req.body.platformEarningsVerified !== true) return res.status(422).json({ success: false, message: "Platform earnings verification is required before crediting a rank bonus." });
  const mode = payoutMode(), field = balanceField(mode);
  await mongoose.connection.transaction(async session => {
    const award = await RankAward.findOneAndUpdate({ _id: req.params.id, status: "pending" }, { $set: { status: "credited", verifiedBy: req.admin, verifiedAt: new Date(), mode } }, { session, new: true });
    if (!award) return;
    const units = Math.round(award.bonus * 1_000_000);
    const result = await User.updateOne({ _id: award.userId, role: "ProTrader", [field]: { $lte: Number.MAX_SAFE_INTEGER - units } }, { $inc: { [field]: units } }, { session });
    if (result.matchedCount !== 1) throw new Error("Bonus balance is unavailable.");
    await AuditLog.create([{ userId: award.userId, action: "Rank Bonus Credited", targetId: award._id, details: { level: award.level, bonus: award.bonus, mode, verifiedBy: req.admin } }], { session });
  });
  return res.json({ success: true, message: "Rank bonus verified and credited, or previously credited.", mode });
});
