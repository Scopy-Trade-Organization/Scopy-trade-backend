import { Request, Response } from "express";
import AuditLog from "../models/auditLogModel.js";
import { Signal } from "../models/signalModel.js";
import User from "../models/userModel.js";

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
      .skip(skip)
      .sort({ createdAt: -1 });

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
