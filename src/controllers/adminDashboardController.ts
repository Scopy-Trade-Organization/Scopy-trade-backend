import { Request, Response } from "express";
import AuditLog from "../models/auditLogModel.js";
import { Signal } from "../models/signalModel.js";
import User from "../models/userModel.js";
import { Trade } from "../models/tradeModel.js";
import mongoose from "mongoose";

export const getTrades = async (req: Request, res: Response) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const status = String(req.query.status || "all");
    const filter: Record<string, unknown> = {};
    if (status === "active") filter.status = { $in: ["pending", "filled"] };
    else if (status === "history") filter.status = { $in: ["closed", "cancelled", "failed"] };
    else if (status !== "all") filter.status = status;

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
      ? await Trade.aggregate<{ _id: mongoose.Types.ObjectId; total: number; active: number; profitable: number }>([
          { $match: { tradeOrigin: "copy", sourceTradeId: { $in: proTradeIds } } },
          {
            $group: {
              _id: "$sourceTradeId",
              total: { $sum: 1 },
              active: { $sum: { $cond: [{ $in: ["$status", ["pending", "filled"]] }, 1, 0] } },
              profitable: { $sum: { $cond: [{ $eq: ["$tradeResult", "profit"] }, 1, 0] } },
            },
          },
        ])
      : [];
    const statsByTrade = new Map(stats.map((item) => [String(item._id), item]));

    return res.status(200).json({
      success: true,
      trades: trades.map((trade) => ({
        ...trade,
        copyStats: trade.tradeOrigin === "pro"
          ? statsByTrade.get(String(trade._id)) ?? { total: 0, active: 0, profitable: 0 }
          : undefined,
      })),
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
    return res.status(200).json({ success: true, trade: { ...trade, copyStats } });
  } catch (error) {
    console.error("Error fetching admin trade:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch trade." });
  }
};

export const getAllSignals = async (req: Request, res: Response) => {
  try {
    const { page = 1, status } = req.query;

    const limit = 10;
    const currentPage = Number(page);
    const skip = (currentPage - 1) * limit;

    const filter: any = {};

    if (status) {
      filter.status = status;
    }

    const signals = await Signal.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip);

    return res.status(200).json({
      success: true,
      message: "Signals retrieved successfully",
      signals,
      page: currentPage,
      limit,
      pageSize: signals.length,
      pages: Math.ceil((await Signal.countDocuments()) / limit),
    });
  } catch (error) {
    console.error("Error fetching signals:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

export const fetchAllUsers = async (req: Request, res: Response) => {
  try {
    const { page = 1, role, status } = req.query;

    if (role) {
      const validRoles = ["CopyTrader", "Pro Trader"];
      if (!validRoles.includes(String(role))) {
        return res.status(400).json({
          success: false,
          message: "Invalid role filter",
        });
      }
    }

    if (status) {
      const validStatuses = ["active", "suspended"];
      if (!validStatuses.includes(String(status))) {
        return res.status(400).json({
          success: false,
          message: "Invalid status filter",
        });
      }
    }

    const filter: any = {};
    if (role) {
      filter.role = role;
    }
    if (status) {
      filter.status = status;
    }

    const limit = 10;
    const currentPage = Number(page);
    const skip = (currentPage - 1) * limit;

    const users = await User.find(filter)
      .select("-password")
      .limit(limit)
      .skip(skip)
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Users retrieved successfully",
      users,
      page: currentPage,
      limit,
      pages: Math.ceil((await User.countDocuments(filter)) / limit),
    });
  } catch (error) {
    console.error("Error fetching users:", error);
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
    user.status = "suspended";
    await user.save();

    await AuditLog.create({
      admin: req.admin,
      action: "User Suspended",
      details: { userId: id },
      ipAddress: req.ip,
      targetId: id,
      userAgent: req.headers["user-agent"],
    });

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
    await user.save();

    await AuditLog.create({
      admin: req.admin,
      action: "User Activated",
      details: { userId: id },
      ipAddress: req.ip,
      targetId: id,
      userAgent: req.headers["user-agent"],
    });

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
