import { Request, Response } from "express";
import AuditLog from "../models/auditLogModel.js";
import User from "../models/userModel.js";
import { Trade } from "../models/tradeModel.js";
import mongoose from "mongoose";
import { withCurrentMarketPrices } from "../services/tradeMarketPriceService.js";
import { queueAccountStatusEmail } from "../services/emailService.js";
import { Settlement } from "../models/settlementModel.js";
import { SUPPORTED_PAIRS } from "../constants.js";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function matchingUserIds(search: string) {
  const terms = search.split(/\s+/).filter(Boolean).slice(0, 5);
  const users = await User.find({
    $and: terms.map((term) => {
      const pattern = new RegExp(escapeRegex(term), "i");
      return {
        $or: [
          { firstName: pattern },
          { lastName: pattern },
          { email: pattern },
          { traderID: pattern },
        ],
      };
    }),
  }).select("_id").lean();
  return users.map((user) => user._id);
}

export const getTrades = async (req: Request, res: Response) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const status = String(req.query.status || "all");
    if (!["all", "active", "history", "pending", "filled", "closed", "cancelled", "failed"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid trade status." });
    }
    const filter: Record<string, unknown> = {};
    if (status === "active") filter.status = { $in: ["pending", "filled"] };
    else if (status === "history") filter.status = { $in: ["closed", "cancelled", "failed"] };
    else if (status !== "all") filter.status = status;

    const pair = String(req.query.pair || "").toUpperCase();
    if (pair) {
      if (!SUPPORTED_PAIRS.includes(pair as (typeof SUPPORTED_PAIRS)[number])) {
        return res.status(400).json({ success: false, message: "Invalid trading pair." });
      }
      filter.pair = pair;
    }
    const direction = String(req.query.direction || "");
    if (direction) {
      if (!["buy", "sell"].includes(direction)) {
        return res.status(400).json({ success: false, message: "Invalid trade direction." });
      }
      filter.direction = direction;
    }
    const tradeOrigin = String(req.query.tradeOrigin || "");
    if (tradeOrigin) {
      if (!["pro", "copy"].includes(tradeOrigin)) {
        return res.status(400).json({ success: false, message: "Invalid trade type." });
      }
      filter.tradeOrigin = tradeOrigin;
    }
    const result = String(req.query.result || "");
    if (result) {
      if (!["profit", "loss", "breakeven"].includes(result)) {
        return res.status(400).json({ success: false, message: "Invalid trade result." });
      }
      filter.tradeResult = result;
    }
    const search = String(req.query.search || "").trim().slice(0, 100);
    if (search) {
      const ownerIds = await matchingUserIds(search);
      const pattern = new RegExp(escapeRegex(search), "i");
      const searchFilters: Record<string, unknown>[] = [
        { tradeId: pattern },
        { userId: { $in: ownerIds } },
      ];
      if (mongoose.isValidObjectId(search)) searchFilters.push({ _id: search });
      filter.$or = searchFilters;
    }

    const [trades, total] = await Promise.all([
      Trade.find(filter)
        .populate("userId", "firstName lastName traderID role profilePhoto")
        .populate("exchangeConnectionId", "exchange label")
        .populate({
          path: "sourceTradeId",
          select: "userId pair",
          populate: { path: "userId", select: "firstName lastName traderID profilePhoto" },
        })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Trade.countDocuments(filter),
    ]);
    const proTradeIds = trades
      .filter((trade) => trade.tradeOrigin === "pro")
      .map((trade) => trade._id);
    const stats = proTradeIds.length
      ? await Trade.aggregate<{ _id: mongoose.Types.ObjectId; total: number; active: number; profitable: number; copierRealizedPnl: number; settlementAmount: number; proTraderShare: number }>([
          { $match: { tradeOrigin: "copy", sourceTradeId: { $in: proTradeIds } } },
          {
            $group: {
              _id: "$sourceTradeId",
              total: { $sum: 1 },
              active: { $sum: { $cond: [{ $in: ["$status", ["pending", "filled"]] }, 1, 0] } },
              profitable: { $sum: { $cond: [{ $eq: ["$tradeResult", "profit"] }, 1, 0] } },
              copierRealizedPnl: { $sum: { $convert: { input: "$realizedPnl", to: "double", onError: 0, onNull: 0 } } },
              settlementAmount: { $sum: { $convert: { input: "$platformFee", to: "double", onError: 0, onNull: 0 } } },
              proTraderShare: { $sum: { $convert: { input: "$proTraderShare", to: "double", onError: 0, onNull: 0 } } },
            },
          },
        ])
      : [];
    const statsByTrade = new Map(stats.map((item) => [String(item._id), item]));

    return res.status(200).json({
      success: true,
      trades: await withCurrentMarketPrices(trades.map((trade) => ({
        ...trade,
        copyStats: trade.tradeOrigin === "pro"
          ? statsByTrade.get(String(trade._id)) ?? { total: 0, active: 0, profitable: 0 }
          : undefined,
      }))),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("Error fetching admin trades:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch trades." });
  }
};

export const getTrade = async (req: Request, res: Response) => {
  try {
    if (!mongoose.isValidObjectId(req.params.tradeId)) {
      return res.status(400).json({ success: false, message: "Invalid trade ID." });
    }
    const trade = await Trade.findById(req.params.tradeId)
      .populate("userId", "firstName lastName traderID role profilePhoto")
      .populate("exchangeConnectionId", "exchange label")
      .populate({
        path: "sourceTradeId",
        select: "userId pair",
        populate: { path: "userId", select: "firstName lastName traderID profilePhoto" },
      })
      .lean();
    if (!trade) return res.status(404).json({ success: false, message: "Trade not found." });
    const copyStats = trade.tradeOrigin === "pro"
      ? {
          total: await Trade.countDocuments({ tradeOrigin: "copy", sourceTradeId: trade._id }),
          active: await Trade.countDocuments({ tradeOrigin: "copy", sourceTradeId: trade._id, status: { $in: ["pending", "filled"] } }),
          profitable: await Trade.countDocuments({ tradeOrigin: "copy", sourceTradeId: trade._id, tradeResult: "profit" }),
        }
      : null;
    const [pricedTrade] = await withCurrentMarketPrices([{ ...trade, copyStats }]);
    return res.status(200).json({ success: true, trade: pricedTrade });
  } catch (error) {
    console.error("Error fetching admin trade:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch trade." });
  }
};

export const getSettlements = async (req: Request, res: Response) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const filter: Record<string, unknown> = {};
    if (["PROCESSING", "SUBMITTED", "COMPLETED", "FAILED"].includes(String(req.query.status || ""))) {
      filter.status = req.query.status;
    }
    const [settlements, total] = await Promise.all([
      Settlement.find(filter)
        .populate("userId", "firstName lastName traderID")
        .populate("exchangeConnectionId", "exchange label")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Settlement.countDocuments(filter),
    ]);
    return res.status(200).json({
      success: true,
      settlements,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("Error fetching settlements:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch settlements." });
  }
};

export const getEarnings = async (req: Request, res: Response) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const category = String(req.query.category || "actual");
    if (!["actual", "prospective"].includes(category)) {
      return res.status(400).json({ success: false, message: "Invalid earnings category." });
    }

    const baseFilter: Record<string, unknown> = {
      tradeOrigin: "copy",
      tradeResult: "profit",
      feeStatus: { $in: ["pending", "processing", "collected", "failed"] },
    };
    const pair = String(req.query.pair || "").toUpperCase();
    if (pair) {
      if (!SUPPORTED_PAIRS.includes(pair as (typeof SUPPORTED_PAIRS)[number])) {
        return res.status(400).json({ success: false, message: "Invalid trading pair." });
      }
      baseFilter.pair = pair;
    }
    const direction = String(req.query.direction || "");
    if (direction) {
      if (!["buy", "sell"].includes(direction)) {
        return res.status(400).json({ success: false, message: "Invalid trade direction." });
      }
      baseFilter.direction = direction;
    }

    const closedAt: Record<string, Date> = {};
    const dateFrom = String(req.query.dateFrom || "");
    const dateTo = String(req.query.dateTo || "");
    if (dateFrom) {
      const parsed = new Date(`${dateFrom}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ success: false, message: "Invalid start date." });
      }
      closedAt.$gte = parsed;
    }
    if (dateTo) {
      const parsed = new Date(`${dateTo}T23:59:59.999Z`);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ success: false, message: "Invalid end date." });
      }
      closedAt.$lte = parsed;
    }
    if (Object.keys(closedAt).length) baseFilter.closedAt = closedAt;

    const search = String(req.query.search || "").trim().slice(0, 100);
    if (search) {
      const ownerIds = await matchingUserIds(search);
      const sourceIds = await Trade.find({ tradeOrigin: "pro", userId: { $in: ownerIds } }).distinct("_id");
      const pattern = new RegExp(escapeRegex(search), "i");
      const searchFilters: Record<string, unknown>[] = [
        { tradeId: pattern },
        { userId: { $in: ownerIds } },
        { sourceTradeId: { $in: sourceIds } },
      ];
      if (mongoose.isValidObjectId(search)) searchFilters.push({ _id: search });
      baseFilter.$or = searchFilters;
    }

    const tableFilter: Record<string, unknown> = { ...baseFilter };
    if (category === "actual") {
      tableFilter.feeStatus = "collected";
    } else {
      const requestedStatus = String(req.query.feeStatus || "");
      if (requestedStatus && !["pending", "processing", "failed"].includes(requestedStatus)) {
        return res.status(400).json({ success: false, message: "Invalid collection status." });
      }
      tableFilter.feeStatus = requestedStatus || { $in: ["pending", "processing", "failed"] };
    }

    const [earnings, total, totals] = await Promise.all([
      Trade.find(tableFilter)
        .select("tradeId userId sourceTradeId pair direction platformFee feeStatus closedAt settlementCompletedAt settlementTransactionId")
        .populate("userId", "firstName lastName traderID email")
        .populate({
          path: "sourceTradeId",
          select: "tradeId userId",
          populate: { path: "userId", select: "firstName lastName traderID" },
        })
        .sort({ closedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Trade.countDocuments(tableFilter),
      Trade.aggregate<{ _id: string; amount: number; count: number }>([
        { $match: baseFilter },
        {
          $group: {
            _id: { $cond: [{ $eq: ["$feeStatus", "collected"] }, "actual", "prospective"] },
            amount: { $sum: { $convert: { input: "$platformFee", to: "double", onError: 0, onNull: 0 } } },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);
    const actual = totals.find((item) => item._id === "actual");
    const prospective = totals.find((item) => item._id === "prospective");
    return res.status(200).json({
      success: true,
      earnings,
      summary: {
        actualAmount: actual?.amount ?? 0,
        prospectiveAmount: prospective?.amount ?? 0,
        actualCount: actual?.count ?? 0,
        prospectiveCount: prospective?.count ?? 0,
      },
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("Error fetching admin earnings:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch platform earnings." });
  }
};

export const fetchAllUsers = async (req: Request, res: Response) => {
  try {
    const { role, status } = req.query;
    const currentPage = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);

    if (role) {
      const validRoles = ["CopyTrader", "ProTrader"];
      if (!validRoles.includes(String(role))) {
        return res.status(400).json({
          success: false,
          message: "Invalid role filter",
        });
      }
    }

    if (status) {
      const validStatuses = ["active", "suspended", "waitlist"];
      if (!validStatuses.includes(String(status))) {
        return res.status(400).json({
          success: false,
          message: "Invalid status filter",
        });
      }
    }

    const filter: Record<string, unknown> = {};
    if (role) {
      filter.role = role;
    }
    if (status) {
      filter.status = status;
    }
    const search = String(req.query.search || "").trim();
    if (search) {
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchPattern = new RegExp(escapedSearch, "i");
      filter.$or = [
        { firstName: searchPattern },
        { lastName: searchPattern },
        { email: searchPattern },
        { traderID: searchPattern },
      ];
    }

    const skip = (currentPage - 1) * limit;
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [users, total, totalUsers, activeUserIds, newUsers, suspendedUsers] =
      await Promise.all([
        User.find(filter)
          .select("-password -sessionVersion")
          .limit(limit)
          .skip(skip)
          .sort({ createdAt: -1 })
          .lean(),
        User.countDocuments(filter),
        User.countDocuments(),
        Trade.distinct("userId", { status: { $in: ["pending", "filled"] } }),
        User.countDocuments({ createdAt: { $gte: monthStart } }),
        User.countDocuments({ status: "suspended" }),
      ]);

    const userIds = users.map((user) => user._id);
    const tradeActivity = userIds.length
      ? await Trade.aggregate<{
          _id: mongoose.Types.ObjectId;
          activeTradeCount: number;
          totalTradeCount: number;
          closedTradeCount: number;
          lastActivityAt: Date;
        }>([
          { $match: { userId: { $in: userIds } } },
          {
            $group: {
              _id: "$userId",
              activeTradeCount: {
                $sum: {
                  $cond: [{ $in: ["$status", ["pending", "filled"]] }, 1, 0],
                },
              },
              totalTradeCount: { $sum: 1 },
              closedTradeCount: {
                $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] },
              },
              lastActivityAt: { $max: "$updatedAt" },
            },
          },
        ])
      : [];
    const activityByUser = new Map(
      tradeActivity.map((activity) => [String(activity._id), activity]),
    );
    const enrichedUsers = users.map((user) => {
      const activity = activityByUser.get(String(user._id));
      return {
        ...user,
        activeTradeCount: activity?.activeTradeCount ?? 0,
        totalTradeCount: activity?.totalTradeCount ?? 0,
        closedTradeCount: activity?.closedTradeCount ?? 0,
        lastActivityAt: activity?.lastActivityAt ?? null,
      };
    });

    return res.status(200).json({
      success: true,
      message: "Users retrieved successfully",
      users: enrichedUsers,
      page: currentPage,
      limit,
      total,
      pages: Math.ceil(total / limit),
      stats: {
        totalUsers,
        activeUsers: activeUserIds.length,
        newUsers,
        suspendedUsers,
      },
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

export const getUserDetails = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid user ID" });
    }

    const user = await User.findById(id)
      .select("-password -sessionVersion")
      .lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const userId = new mongoose.Types.ObjectId(id);
    const [tradeStats] = await Trade.aggregate<{
      _id: null;
      totalTrades: number;
      activeTrades: number;
      closedTrades: number;
      profitableTrades: number;
      losingTrades: number;
      lastActivityAt: Date;
    }>([
      { $match: { userId } },
      {
        $group: {
          _id: null,
          totalTrades: { $sum: 1 },
          activeTrades: {
            $sum: {
              $cond: [{ $in: ["$status", ["pending", "filled"]] }, 1, 0],
            },
          },
          closedTrades: {
            $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] },
          },
          profitableTrades: {
            $sum: { $cond: [{ $eq: ["$tradeResult", "profit"] }, 1, 0] },
          },
          losingTrades: {
            $sum: { $cond: [{ $eq: ["$tradeResult", "loss"] }, 1, 0] },
          },
          lastActivityAt: { $max: "$updatedAt" },
        },
      },
    ]);
    const recentTrades = await Trade.find({ userId })
      .select("pair direction status tradeOrigin tradeResult createdAt updatedAt closedAt")
      .sort({ updatedAt: -1 })
      .limit(5)
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        user,
        tradeStats: tradeStats ?? {
          totalTrades: 0,
          activeTrades: 0,
          closedTrades: 0,
          profitableTrades: 0,
          losingTrades: 0,
          lastActivityAt: null,
        },
        recentTrades,
      },
    });
  } catch (error) {
    console.error("Error fetching user details:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

export const suspendUser = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }
    const { reason } = req.body;
    user.status = "suspended";
    user.suspendReason = typeof reason === "string" ? reason.trim().slice(0, 500) : null;
    await user.save();

    await AuditLog.create({
      admin: req.admin,
      action: "User Suspended",
      details: { userId: id },
      ipAddress: req.ip,
      targetId: id,
      userAgent: req.headers["user-agent"],
    });

    queueAccountStatusEmail(user.email, user.firstName, "suspended", user.suspendReason ?? undefined);

    return res.status(200).json({
      success: true,
      message: "User suspended successfully",
    });
  } catch (error) {
    console.error("Error suspending user:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

export const activateUser = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }
    user.status = "active";
    user.suspendReason = null;
    await user.save();

    await AuditLog.create({
      admin: req.admin,
      action: "User Activated",
      details: { userId: id },
      ipAddress: req.ip,
      targetId: id,
      userAgent: req.headers["user-agent"],
    });

    queueAccountStatusEmail(user.email, user.firstName, "active");

    return res.status(200).json({
      success: true,
      message: "User activated successfully",
    });
  } catch (error) {
    console.error("Error activating user:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

export const fetchAuditLogs = async (req: Request, res: Response) => {
  try {
    const { page = 1, action } = req.query;
    const filter: any = {};

    if (action) {
      filter.action = action;
    }

    const limit = 10;
    const currentPage = Number(page);
    const skip = (currentPage - 1) * limit;

    const logs = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip);

    return res.status(200).json({
      success: true,
      message: "Audit logs retrieved successfully",
      logs,
      page: currentPage,
      limit,
      pages: Math.ceil((await AuditLog.countDocuments(filter)) / limit),
    });
  } catch (error) {
    console.error("Error fetching audit logs:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};
