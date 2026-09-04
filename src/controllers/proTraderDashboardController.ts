import { Request, Response } from "express";
import mongoose from "mongoose";
import AuditLog from "../models/auditLogModel.js";
import { Signal } from "../models/signalModel.js";
import { Trade } from "../models/tradeModel.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import {
  amendTradeOrder,
  closeTradeOrder,
  getOrderStatus,
} from "../services/tradeService.js";
import { decryptCredentials } from "../services/exchangeConnectionService.js";
import { getTradeMonitorService } from "../services/tradeMonitorService.js";
import { ExchangeId } from "../types/index.js";
import User from "../models/userModel.js";
import { TronWeb } from "tronweb";
import { isValidTronAddress } from "../helpers/tronAddress.js";
import { queueCopiedTradeUpdate, triggerCopiedTradeClosures } from "../services/copiedTradeUpdateService.js";
import { withCurrentMarketPrices } from "../services/tradeMarketPriceService.js";
import { processTradeClose } from "../services/profitSharingService.js";

export const getProTrades = async (req: Request, res: Response) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const requestedStatus = String(req.query.status || "all");
    const filter: Record<string, unknown> = { userId: req.user, tradeOrigin: "pro" };
    if (requestedStatus === "active") filter.status = { $in: ["pending", "filled"] };
    else if (requestedStatus === "history") filter.status = { $in: ["closed", "cancelled", "failed"] };
    else if (requestedStatus !== "all") filter.status = requestedStatus;
    const [trades, total] = await Promise.all([
      Trade.find(filter)
        .populate("signalId", "notes")
        .populate("exchangeConnectionId", "exchange label")
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip((page - 1) * limit)
        .lean(),
      Trade.countDocuments(filter),
    ]);

    const tradeIds = trades.map((trade) => trade._id);
    const copyStats = await Trade.aggregate<{
      _id: mongoose.Types.ObjectId;
      total: number;
      active: number;
      profitable: number;
      copiedVolume: number;
    }>([
      { $match: { tradeOrigin: "copy", sourceTradeId: { $in: tradeIds } } },
      {
        $group: {
          _id: "$sourceTradeId",
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $in: ["$status", ["pending", "filled"]] }, 1, 0] } },
          profitable: { $sum: { $cond: [{ $eq: ["$tradeResult", "profit"] }, 1, 0] } },
          copiedVolume: { $sum: { $convert: { input: "$quantity", to: "double", onError: 0, onNull: 0 } } },
        },
      },
    ]);
    const statsByTrade = new Map(copyStats.map((item) => [String(item._id), item]));

    return res.status(200).json({
      success: true,
      message: "Trades retrieved successfully",
      trades: await withCurrentMarketPrices(trades.map((trade) => ({
        ...trade,
        copyStats: statsByTrade.get(String(trade._id)) ?? {
          total: 0,
          active: 0,
          profitable: 0,
          copiedVolume: 0,
        },
      }))),
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

export const updateProTrade = async (req: Request, res: Response) => {
  try {
    const { tradeId } = req.params;
    const trade = await Trade.findOne({
      _id: tradeId,
      userId: req.user,
      tradeOrigin: "pro",
      status: { $in: ["pending", "filled"] },
    });

    if (!trade) {
      return res.status(404).json({
        success: false,
        message: "Active pro trade not found.",
      });
    }

    const connection = await ExchangeConnection.findOne({
      _id: trade.exchangeConnectionId,
      userId: req.user,
      isActive: true,
    }).lean();
    if (!connection?.encryptedApiKey || !connection.encryptedApiSecret) {
      return res.status(409).json({
        success: false,
        message: "The exchange connection for this trade is unavailable.",
      });
    }
    if (!trade.exchangeOrderId) {
      return res.status(409).json({
        success: false,
        message: "This trade has no exchange order to amend.",
      });
    }

    const credentials = decryptCredentials({
      exchange: connection.exchange as ExchangeId,
      apiKey: connection.encryptedApiKey,
      apiSecret: connection.encryptedApiSecret,
      ...(connection.encryptedPassphrase
        ? { passphrase: connection.encryptedPassphrase }
        : {}),
    });
    const live = await getOrderStatus(
      connection.exchange as ExchangeId,
      credentials,
      trade.pair,
      trade.exchangeOrderId,
    );
    if (!["pending", "filled"].includes(live.status)) {
      return res.status(409).json({
        success: false,
        message: `The exchange reports this order as ${live.status}; it can no longer be edited.`,
      });
    }

    const raw = live.raw as any;
    const partiallyFilled =
      Number(raw?.executedQty ?? 0) > 0 ||
      raw?.result?.list?.[0]?.orderStatus === "PartiallyFilled" ||
      raw?.data?.[0]?.state === "partially_filled" ||
      raw?.data?.status === "partial_fill";
    const entryLocked =
      live.status === "filled" || trade.status === "filled" || partiallyFilled;

    const requestedEntry = String(req.body.entryPrice ?? trade.entryPrice);
    const requestedTp = String(req.body.tp ?? trade.tp);
    const requestedSl = String(req.body.sl ?? trade.sl);
    const values = [requestedEntry, requestedTp, requestedSl].map(Number);
    if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
      return res.status(400).json({
        success: false,
        message: "Entry, take-profit, and stop-loss must be positive numbers.",
      });
    }
    if (entryLocked && requestedEntry !== trade.entryPrice) {
      return res.status(409).json({
        success: false,
        message: "Entry price cannot be changed after the order starts filling.",
      });
    }

    const effectiveEntry = Number(
      entryLocked ? live.filledPrice || trade.entryFillPrice || trade.entryPrice : requestedEntry,
    );
    const takeProfit = Number(requestedTp);
    const stopLoss = Number(requestedSl);
    const validLevels =
      trade.direction === "buy"
        ? stopLoss < effectiveEntry && effectiveEntry < takeProfit
        : takeProfit < effectiveEntry && effectiveEntry < stopLoss;
    if (!validLevels) {
      return res.status(422).json({
        success: false,
        message:
          trade.direction === "buy"
            ? "A long trade requires stop loss < entry < take profit."
            : "A short trade requires take profit < entry < stop loss.",
      });
    }

    const entryChanged = requestedEntry !== trade.entryPrice;
    const tpChanged = requestedTp !== trade.tp;
    const slChanged = requestedSl !== trade.sl;
    if (!entryChanged && !tpChanged && !slChanged) {
      return res.status(200).json({
        success: true,
        message: "Trade parameters are unchanged.",
        trade: {
          ...trade.toObject(),
          exchangeConnectionId: {
            _id: connection._id,
            exchange: connection.exchange,
            label: connection.label,
          },
          entryEditable: !entryLocked,
        },
      });
    }
    if (connection.exchange === "okx" && (tpChanged || slChanged)) {
      return res.status(422).json({
        success: false,
        message: "OKX protection amendments are not yet supported; only a pending entry price can be changed.",
      });
    }

    const amended = await amendTradeOrder(connection.exchange as ExchangeId, {
      credentials,
      pair: trade.pair,
      direction: trade.direction as "buy" | "sell",
      quantity: trade.quantity,
      entryPrice: requestedEntry,
      tp: requestedTp,
      sl: requestedSl,
      orderId: trade.exchangeOrderId,
      status: entryLocked ? "filled" : "pending",
      entryChanged,
      protectionChanged: tpChanged || slChanged,
      protectionOrderIds: trade.exchangeProtectionOrderIds,
      ...(trade.exchangeProtectionOrderTransport !== undefined
        ? { protectionTransport: trade.exchangeProtectionOrderTransport }
        : {}),
    });

    trade.entryPrice = amended.entryPrice;
    trade.tp = amended.tp;
    trade.sl = amended.sl;
    if (amended.orderId) trade.exchangeOrderId = amended.orderId;
    if (live.status === "filled") trade.status = "filled";
    if (live.filledPrice) trade.entryFillPrice = live.filledPrice;
    if (amended.protectionOrderIds) {
      trade.exchangeProtectionOrderIds = amended.protectionOrderIds;
      trade.exchangeProtectionOrderTransport = amended.protectionTransport ?? "algo";
    }
    trade.rawStatusResponse = {
      status: live.raw,
      lastAmendment: amended.raw,
      amendedAt: new Date().toISOString(),
    };
    await trade.save();
    await Signal.updateOne(
      { _id: trade.signalId },
      { $set: { entry: trade.entryPrice, tp: trade.tp, sl: trade.sl } },
    );

    if (tpChanged || slChanged) {
      queueCopiedTradeUpdate(String(trade._id), { tp: trade.tp, sl: trade.sl });
    }

    const monitor = getTradeMonitorService();
    await monitor.stopMonitoring(String(trade._id));
    await monitor.startMonitoring(String(trade._id));
    monitor.emit("tradeUpdate", {
      tradeId: String(trade._id),
      exchangeOrderId: trade.exchangeOrderId,
      status: trade.status,
      tp: trade.tp,
      sl: trade.sl,
      timestamp: new Date(),
    });

    await AuditLog.create({
      userId: req.user,
      action: "Pro Trade Parameters Updated",
      details: {
        tradeId: trade._id,
        entryPrice: trade.entryPrice,
        tp: trade.tp,
        sl: trade.sl,
        entryLocked,
        exchange: connection.exchange,
      },
      targetId: trade._id,
      targetType: "Trade",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.status(200).json({
      success: true,
      message: "Trade parameters updated successfully. Copied positions are syncing in the background.",
      trade: {
        ...trade.toObject(),
        exchangeConnectionId: {
          _id: connection._id,
          exchange: connection.exchange,
          label: connection.label,
        },
        entryEditable: !entryLocked,
      },
    });
  } catch (error) {
    console.error("Error updating pro trade:", error);
    return res.status(502).json({
      success: false,
      message: "Failed to update trade parameters.",
    });
  }
};

export const closeProTrade = async (req: Request, res: Response) => {
  try {
    const { tradeId } = req.params;
    const trade = await Trade.findOne({
      _id: tradeId,
      userId: req.user,
      tradeOrigin: "pro",
      status: { $in: ["pending", "filled"] },
    });
    if (!trade) {
      return res.status(404).json({ success: false, message: "Active pro trade not found." });
    }
    if (!trade.exchangeOrderId) {
      return res.status(409).json({ success: false, message: "This trade has no exchange order to close." });
    }

    const connection = await ExchangeConnection.findOne({
      _id: trade.exchangeConnectionId,
      userId: req.user,
      isActive: true,
    }).lean();
    if (!connection?.encryptedApiKey || !connection.encryptedApiSecret) {
      return res.status(409).json({ success: false, message: "The exchange connection for this trade is unavailable." });
    }
    const exchange = connection.exchange as ExchangeId;
    const credentials = decryptCredentials({
      exchange,
      apiKey: connection.encryptedApiKey,
      apiSecret: connection.encryptedApiSecret,
      ...(connection.encryptedPassphrase ? { passphrase: connection.encryptedPassphrase } : {}),
    });
    const live = await getOrderStatus(exchange, credentials, trade.pair, trade.exchangeOrderId);
    if (!['pending', 'filled'].includes(live.status)) {
      return res.status(409).json({ success: false, message: `The exchange reports this order as ${live.status}; it can no longer be closed manually.` });
    }
    const closeStatus = live.status === "filled" ? "filled" : "pending";
    const result = await closeTradeOrder(exchange, {
      credentials,
      pair: trade.pair,
      direction: trade.direction as "buy" | "sell",
      quantity: trade.quantity,
      orderId: trade.exchangeOrderId,
      status: closeStatus,
    });

    const monitor = getTradeMonitorService();
    await monitor.stopMonitoring(String(trade._id));
    if (result.status === "cancelled") {
      trade.status = "cancelled";
      trade.closedAt = new Date();
      trade.closedVia = "manual";
      trade.wsMonitoringActive = false;
      trade.monitoringStatus = "disconnected";
      await trade.save();
    } else {
      // Bybit can report a zero position when native TP/SL closed the entry
      // before this request. No historical exit price is available from the
      // position endpoint, so retain the entry price rather than recording a
      // misleading current market price and charging an inaccurate PnL.
      const exitPrice = result.alreadyClosed
        ? trade.entryFillPrice || trade.entryPrice
        : result.exitPrice || live.filledPrice || trade.entryFillPrice || trade.entryPrice;
      await processTradeClose(String(trade._id), exitPrice, "manual");
    }

    // Deliberately do not await copy closures. The pro close has succeeded and the propagation has been triggered.
    triggerCopiedTradeClosures(String(trade._id));
    const updated = await Trade.findById(trade._id)
      .populate("exchangeConnectionId", "exchange label")
      .lean();
    monitor.emit("tradeUpdate", { tradeId: String(trade._id), status: result.status, timestamp: new Date() });
    await AuditLog.create({
      userId: req.user,
      action: "Pro Trade Closed Manually",
      details: { tradeId: trade._id, exchange, copyCloseTriggered: true },
      targetId: trade._id,
      targetType: "Trade",
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    return res.status(200).json({
      success: true,
      message: result.alreadyClosed
        ? "Bybit reports no open position for this trade. Its local status has been synchronized as closed."
        : result.status === "closed"
        ? "Trade closed. Copied trades are being closed in the background."
        : "Pending trade cancelled. Copied trades are being closed in the background.",
      trade: updated,
    });
  } catch (error) {
    console.error("Error closing pro trade:", error);
    return res.status(502).json({ success: false, message: "Failed to close pro trade." });
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
    const { address } = req.body;

    if (!isValidTronAddress(address)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid TRC-20 wallet address. Provide a valid Tron (TRC-20) address: 34 characters, starting with 'T', with a correct checksum.",
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
      proEarningsBalance: user.proEarningsBalance ?? 0,
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

    // Reject anything that is not a positive, finite number.
    const numericAmount = Number(amount);
    if (
      amount === undefined ||
      amount === null ||
      amount === "" ||
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid amount is required",
      });
    }

    // USDT (TRC-20) carries 6 decimals. Reject higher precision so the
    // base-unit conversion below is always an exact integer.
    if (!/^\d+(\.\d{1,6})?$/.test(String(amount).trim())) {
      return res.status(400).json({
        success: false,
        message: "Amount must be a positive number with at most 6 decimal places (USDT precision).",
      });
    }

    const user = await User.findById(req.user);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!isValidTronAddress(user.withdrawalAddress)) {
      return res.status(400).json({
        success: false,
        message: "No valid withdrawal address on file. Please save your TRC-20 wallet address first.",
      });
    }

    // Verify server configuration BEFORE debiting the user, so a
    // misconfiguration can never strand a balance deduction.
    const privateKey = process.env.TRON_COMPANY_PRIVATE_KEY;
    const usdtContractAddress = process.env.TRON_USDT_CONTRACT_ADDRESS;
    if (!privateKey || !usdtContractAddress) {
      console.error(
        "Withdrawal blocked: missing TRON_COMPANY_PRIVATE_KEY or TRON_USDT_CONTRACT_ADDRESS.",
      );
      return res.status(500).json({
        success: false,
        message: "Withdrawal is temporarily unavailable. Please try again later.",
      });
    }

    // Atomically authorize and debit the user's earnings balance. The $gte
    // guard makes this safe under concurrent requests: a second request cannot
    // overdraw because the conditional update only matches while the funds are
    // still present. This is the authorization check — without it any Pro
    // Trader could drain the company wallet.
    const debited = await User.findOneAndUpdate(
      { _id: req.user, proEarningsBalance: { $gte: numericAmount } },
      { $inc: { proEarningsBalance: -numericAmount } },
      { new: true },
    );
    if (!debited) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance for this withdrawal.",
      });
    }

    let transactionId: string;
    try {
      const tronHost = process.env.TRON_FULL_HOST || "https://api.trongrid.io";
      const tronWeb = new TronWeb({
        fullHost: tronHost,
        privateKey: privateKey,
      });

      const contract = await tronWeb.contract().at(usdtContractAddress);

      // Convert to integer base units (6 decimals). The regex above guarantees
      // at most 6 decimal places, so this is always a whole number.
      const amountInBaseUnits = tronWeb
        .toBigNumber(amount)
        .times(1_000_000)
        .toString(10);

      transactionId = await contract
        .transfer(user.withdrawalAddress, amountInBaseUnits)
        .send({ feeLimit: 100_000_000 });
    } catch (txError) {
      // Broadcast failed — refund the debit so the user is made whole. Note we
      // deliberately do NOT refund on downstream errors (e.g. audit logging),
      // which would risk refunding a withdrawal that was actually broadcast.
      await User.updateOne(
        { _id: req.user },
        { $inc: { proEarningsBalance: numericAmount } },
      );
      console.error("Error executing withdrawal, balance refunded:", txError);
      return res.status(502).json({
        success: false,
        message: "Withdrawal could not be broadcast to the Tron network. Your balance was not charged.",
      });
    }

    await AuditLog.create({
      userId: req.user,
      action: "Withdrawal Executed",
      details: {
        amount: numericAmount,
        destinationAddress: user.withdrawalAddress,
        transactionId,
        remainingBalance: debited.proEarningsBalance,
      },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.status(200).json({
      success: true,
      message: "Withdrawal initiated successfully",
      transactionId,
      remainingBalance: debited.proEarningsBalance,
    });
  } catch (error) {
    console.error("Error executing withdrawal:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

