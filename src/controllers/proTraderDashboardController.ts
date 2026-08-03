import { Request, Response } from "express";
import AuditLog from "../models/auditLogModel.js";
import { Signal } from "../models/signalModel.js";
import { Trade } from "../models/tradeModel.js";
import User from "../models/userModel.js";
import { TronWeb } from "tronweb";

export const getProTrades = async (req: Request, res: Response) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = 10;
    const filter = { userId: req.user, tradeOrigin: "pro" as const };
    const [trades, total] = await Promise.all([
      Trade.find(filter)
        .populate("signalId", "notes")
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip((page - 1) * limit)
        .lean(),
      Trade.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      message: "Trades retrieved successfully",
      trades,
      page,
      limit,
      pageSize: trades.length,
      pages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (error) {
    console.error("Error fetching pro trades:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch trades",
    });
  }
};

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

export const saveWalletAddress = async (req: Request, res: Response) => {
  try {
    console.log("saveWalletAddress req.body:", req.body);
    const { address } = req.body;
    
    console.log("saveWalletAddress address length:", address?.length);

    if (!address || typeof address !== "string" || !address.startsWith("T") || address.length !== 34) {
      return res.status(400).json({
        success: false,
        message: "Invalid TRC-20 wallet address. It must be a non-empty string, start with 'T', and be exactly 34 characters long.",
      });
    }

    const user = await User.findByIdAndUpdate(
      req.user,
      { withdrawalAddress: address },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    await AuditLog.create({
      userId: req.user,
      action: "Wallet Address Updated",
      details: { address },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.status(200).json({
      success: true,
      message: "Wallet address saved successfully",
      withdrawalAddress: user.withdrawalAddress,
    });
  } catch (error) {
    console.error("Error saving wallet address:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const getWalletAddress = async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.user);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.status(200).json({
      success: true,
      withdrawalAddress: user.withdrawalAddress || null,
      requirements: {
        format: "TRC-20 (Tron Network)",
        mustStartWith: "T",
        length: 34,
        example: "TRX address from any Tron wallet",
      },
    });
  } catch (error) {
    console.error("Error fetching wallet address:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const withdrawFunds = async (req: Request, res: Response) => {
  try {
    const { amount } = req.body;

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "A valid amount is required",
      });
    }

    const user = await User.findById(req.user);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!user.withdrawalAddress) {
      return res.status(400).json({
        success: false,
        message: "No withdrawal address found. Please save your TRC-20 wallet address first.",
      });
    }

    // TODO: Validate that the user has sufficient balance in the SCopyTrade system
    // const hasSufficientBalance = ... 
    // if (!hasSufficientBalance) return res.status(400).json({ message: "Insufficient balance" });

    const privateKey = process.env.TRON_COMPANY_PRIVATE_KEY;
    if (!privateKey) {
      return res.status(500).json({ success: false, message: "Server configuration error: Missing Tron private key" });
    }

    const usdtContractAddress = process.env.TRON_USDT_CONTRACT_ADDRESS;
    if (!usdtContractAddress) {
      return res.status(500).json({ success: false, message: "Server configuration error: Missing USDT contract address" });
    }

    const tronHost = process.env.TRON_FULL_HOST || "https://api.trongrid.io";

    const tronWeb = new TronWeb({
      fullHost: tronHost,
      privateKey: privateKey,
    });

    const contract = await tronWeb.contract().at(usdtContractAddress);
    
    // Convert amount to USDT decimals (6)
    const amountInSun = tronWeb.toBigNumber(amount).times(1_000_000).toString(10);
    
    const transactionId = await contract.transfer(user.withdrawalAddress, amountInSun).send();

    await AuditLog.create({
      userId: req.user,
      action: "Withdrawal Executed",
      details: {
        amount,
        destinationAddress: user.withdrawalAddress,
        transactionId,
      },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.status(200).json({
      success: true,
      message: "Withdrawal initiated successfully",
      transactionId,
    });
  } catch (error) {
    console.error("Error executing withdrawal:", error);
    return res.status(500).json({
      success: false,
      message: (error as Error).message || "Internal server error",
    });
  }
};

