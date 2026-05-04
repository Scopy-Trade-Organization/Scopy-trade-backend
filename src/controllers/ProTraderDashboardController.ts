import { Request, Response } from "express";
import AuditLog from "../models/auditLogModel.js";
import { Signal } from "../models/signalModel.js";

export const createSignal = async (req: Request, res: Response) => {
  try {
    const { pair, tp, sl, entry } = req.body;

    const traderId = req.user;

    // Validate required fields
    if (!pair || !tp || !sl || !entry) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    const newSignal = await Signal.create({
      pair,
      tp,
      sl,
      entry,
      trader: traderId,
    });

    await AuditLog.create({
      userId: req.user,
      action: "New Trade Signal Created",
      details: {
        signalId: newSignal._id,
        pair,
        tp,
        sl,
        entry,
      },
      targetId: newSignal._id,
      targetType: "Signal Creation",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.status(201).json({
      success: true,
      message: "Signal created successfully",
      signal: newSignal,
    });
  } catch (error) {
    console.error("Error creating signal:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

export const deleteSignal = async (req: Request, res: Response) => {
  try {
    const { signalId } = req.params;
    const signal = await Signal.findOneAndDelete({
      _id: signalId,
      trader: req.user,
    });

    if (!signal) {
      return res.status(404).json({
        success: false,
        message: "Signal not found for this trader",
      });
    }

    await AuditLog.create({
      userId: req.user,
      action: "Trade Signal Deleted",
      details: { signalId },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.status(200).json({
      success: true,
      message: "Signal deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting signal:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

export const updateSignal = async (req: Request, res: Response) => {
  try {
    const { signalId } = req.params;
    const { pair, tp, sl, entry } = req.body;

    const updatedSignal = await Signal.findByIdAndUpdate(
      { _id: signalId, trader: req.user },
      { pair, tp, sl, entry },
      { new: true },
    );

    if (!updatedSignal) {
      return res.status(404).json({
        success: false,
        message: "Signal not found",
      });
    }

    await AuditLog.create({
      userId: req.user,
      action: "Trade Signal Updated",
      details: {
        signalId,
        pair,
        tp,
        sl,
        entry,
      },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.status(200).json({
      success: true,
      message: "Signal updated successfully",
      signal: updatedSignal,
    });
  } catch (error) {
    console.error("Error updating signal:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

export const getAllSignals = async (req: Request, res: Response) => {
  try {
    const { page = 1 } = req.query;

    const limit = 10;
    const currentPage = Number(page);
    const skip = (currentPage - 1) * limit;

    const signals = await Signal.find({ trader: req.user })
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
