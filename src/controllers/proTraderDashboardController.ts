import { Request, Response } from "express";
import AuditLog from "../models/auditLogModel.js";
import { Signal } from "../models/signalModel.js";
import { decryptCredentials, withdrawUsdt } from "../services/exchangeService.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import { EncryptedCredentials } from "../types/index.js";

export const createSignal = async (req: Request, res: Response) => {
  try {
    const { pair, tp, notes, sl, direction, entry } = req.body;

    const traderId = req.user;

    // Validate required fields
    if (!pair || !tp || !sl || !direction || !entry) {
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
      direction,
      notes,
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
        direction,
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
    const { pair, tp, notes, sl, direction, entry } = req.body;

    const signal = await Signal.findOne({ _id: signalId, trader: req.user });

    if (!signal) {
      return res.status(404).json({
        success: false,
        message: "Signal not found for this trader",
      });
    }

    if (signal.status === "expired") {
      return res.status(400).json({
        success: false,
        message: "Cannot update an expired signal",
      });
    }

    const updatedSignal = await Signal.findOneAndUpdate(
      { _id: signalId, trader: req.user },
      { pair, tp, notes, sl, direction, entry },
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
        notes,
        sl,
        direction,
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
      .skip(skip);

    return res.status(200).json({
      success: true,
      message: "Signals retrieved successfully",
      signals,
      page: currentPage,
      limit,
      pageSize: signals.length,
      pages: Math.ceil((await Signal.countDocuments({ trader: req.user })) / limit),
    });
  } catch (error) {
    console.error("Error fetching signals:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

export const withdrawFunds = async (req: Request, res: Response) => {
  try {
    const { amount, destinationAddress } = req.body;

    if (!amount || !destinationAddress) {
      return res.status(400).json({
        success: false,
        message: "Amount and destination address are required",
      });
    }

    // Find active exchange connection for the logged-in pro-trader
    const connection = await ExchangeConnection.findOne({
      userId: req.user,
      isActive: true,
    });

    if (!connection) {
      return res.status(400).json({
        success: false,
        message: "No active exchange connection found.",
      });
    }

    if (!connection.encryptedApiKey || !connection.encryptedApiSecret) {
      return res.status(422).json({
        success: false,
        message: "Exchange credentials are missing. Please reconnect your exchange.",
      });
    }

    // Decrypt credentials
    const storedCredentials: EncryptedCredentials = {
      exchange: connection.exchange,
      apiKey: connection.encryptedApiKey,
      apiSecret: connection.encryptedApiSecret,
      ...(connection.encryptedPassphrase != null && {
        passphrase: connection.encryptedPassphrase,
      }),
    };

    const credentials = decryptCredentials(storedCredentials);

    // Call unified withdrawal service
    const amountStr = String(amount);
    const result = await withdrawUsdt(
      connection.exchange,
      credentials,
      amountStr,
      destinationAddress,
    );

    // Log the withdrawal in AuditLog
    await AuditLog.create({
      userId: req.user,
      action: "Exchange Withdrawal Initiated",
      details: {
        exchange: connection.exchange,
        connectionId: connection._id,
        amount: amountStr,
        destinationAddress,
        transactionId: result.transactionId,
      },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.status(200).json({
      success: true,
      message: "Withdrawal initiated successfully",
      transactionId: result.transactionId,
      data: result.raw,
    });
  } catch (error) {
    console.error("Error initiating withdrawal:", error);
    return res.status(500).json({
      success: false,
      message: (error as Error).message || "Internal server error",
    });
  }
};

