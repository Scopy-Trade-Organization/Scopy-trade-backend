import type { Request, Response } from "express";
import mongoose from "mongoose";
import rateLimit from "express-rate-limit";
import User from "../models/userModel.js";
import AuditLog from "../models/auditLogModel.js";
import { Trade } from "../models/tradeModel.js";
import { ProEarning, ProWithdrawal } from "../models/proFinanceModel.js";
import { isValidTronAddress } from "../helpers/tronAddress.js";
import { formatUsdt, usdtUnits } from "../helpers/usdt.js";
import { consumeOtp, issueOtp } from "../services/otpService.js";
import { sendOtpEmail } from "../services/emailService.js";
import {
  balanceField,
  liveClient,
  payoutMode,
} from "../services/proFinanceService.js";

class InputError extends Error {}

export const financeLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  keyGenerator: (req) => String(req.user),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many financial requests. Try again in 15 minutes.",
  },
});

function handler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      await fn(req, res);
    } catch (error) {
      const input = error instanceof InputError;
      if (!input)
        console.error("[Pro finance] Request failed", {
          name: error instanceof Error ? error.name : "Unknown",
        });
      res.status(input ? 400 : 503).json({
        success: false,
        message: input
          ? error.message
          : "Financial service temporarily unavailable. Retry with the same request ID.",
      });
    }
  };
}

async function account(req: Request) {
  const user = await User.findOne({
    _id: req.user,
    role: "ProTrader",
    status: "active",
    isVerified: true,
  }).lean();
  if (!user)
    throw new InputError("An active, verified pro-trader account is required.");
  return user;
}

function amountUnits(value: unknown) {
  try {
    const units = usdtUnits(value);
    if (!units) throw new Error();
    return units;
  } catch {
    throw new InputError(
      "Enter a positive USDT amount as text, with at most 6 decimals.",
    );
  }
}

function requestId(req: Request) {
  const value = req.get("Idempotency-Key");
  if (!value || !/^[a-zA-Z0-9_-]{16,80}$/.test(value))
    throw new InputError("A valid Idempotency-Key is required.");
  return value;
}

function wallet(value: unknown): string {
  if (typeof value !== "string" || !isValidTronAddress(value))
    throw new InputError("Enter a valid TRON wallet address.");
  return value;
}

function context(mode: string, units: number, address: string, key: string) {
  return JSON.stringify(["pro-withdrawal", mode, units, address, key]);
}

function ready(user: Awaited<ReturnType<typeof account>>, mode: string) {
  wallet(user.withdrawalAddress);
  if (mode === "live") {
    liveClient();
    if (
      !user.withdrawalAddressChangedAt ||
      Date.now() - user.withdrawalAddressChangedAt.getTime() < 24 * 60 * 60_000
    ) {
      throw new InputError(
        "Live withdrawals unlock 24 hours after verifying your wallet.",
      );
    }
  }
}

function page(req: Request) {
  const value = Number(req.query.page || 1);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000)
    throw new InputError("Invalid page.");
  return value;
}

function publicWithdrawal(row: any) {
  return {
    _id: row._id,
    requestId: row.requestId,
    mode: row.mode,
    amount: formatUsdt(row.units),
    address: row.address,
    status: row.status,
    transactionId: row.transactionId,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

export const getFinanceSummary = handler(async (req, res) => {
  const user = await account(req);
  const mode = payoutMode();
  const [earned, reserved] = await Promise.all([
    ProEarning.aggregate([
      { $match: { userId: req.user, mode } },
      { $group: { _id: null, units: { $sum: "$units" } } },
    ]),
    ProWithdrawal.aggregate([
      {
        $match: {
          userId: req.user,
          mode,
          status: { $in: ["QUEUED", "SIGNED", "REVIEW"] },
        },
      },
      { $group: { _id: null, units: { $sum: "$units" } } },
    ]),
  ]);
  res.json({
    success: true,
    accountId: String(user._id),
    demoFundingEnabled:
      mode === "demo" &&
      process.env.PRO_DEMO_FUNDING_ENABLED === "true" &&
      !user.proDemoGranted,
    legacyBalance: String(user.proEarningsBalance || 0),
    mode,
    available: formatUsdt(user[balanceField(mode)] || 0),
    earned: formatUsdt(earned[0]?.units || 0),
    reserved: formatUsdt(reserved[0]?.units || 0),
    withdrawalAddress: user.withdrawalAddress || null,
    walletUnlocksAt: user.withdrawalAddressChangedAt
      ? new Date(
          user.withdrawalAddressChangedAt.getTime() + 24 * 60 * 60_000,
        ).toISOString()
      : null,
    liveEnabled: process.env.PRO_PAYOUT_LIVE_ENABLED === "true",
  });
});

export const getWalletAddress = getFinanceSummary;
async function throttleOtp(userId: mongoose.Types.ObjectId) {
  const result = await User.updateOne(
    {
      _id: userId,
      $or: [
        { financeOtpSentAt: null },
        { financeOtpSentAt: { $lt: new Date(Date.now() - 60_000) } },
      ],
    },
    { $set: { financeOtpSentAt: new Date() } },
  );
  if (!result.modifiedCount)
    throw new InputError("Wait one minute before requesting another code.");
}

export const grantDemoFunds = handler(async (req, res) => {
  const user = await account(req);
  if (
    payoutMode() !== "demo" ||
    process.env.PRO_DEMO_FUNDING_ENABLED !== "true"
  )
    throw new InputError("Demo funding is disabled.");
  await mongoose.connection.transaction(
    async (session) => {
      const result = await User.updateOne(
        { _id: user._id, proDemoGranted: { $ne: true } },
        { $set: { proDemoGranted: true }, $inc: { proDemoUnits: 100_000_000 } },
        { session },
      );
      if (result.modifiedCount)
        await AuditLog.create(
          [
            {
              userId: user._id,
              action: "Demo Funds Granted",
              details: { units: 100_000_000, mode: "demo" },
            },
          ],
          { session },
        );
    },
    { writeConcern: { w: "majority" }, readConcern: { level: "snapshot" } },
  );
  res.json({ success: true, message: "Demo funds available." });
});

export const requestWalletOtp = handler(async (req, res) => {
  const user = await account(req);
  const address = wallet(req.body.address);
  await throttleOtp(user._id);
  const code = await issueOtp({
    email: user.email,
    userId: user._id,
    purpose: "withdrawal",
    context: JSON.stringify(["pro-wallet", address]),
  });
  await sendOtpEmail(
    user.email,
    user.firstName,
    code,
    "withdrawal",
    "Verify TRON withdrawal wallet: " + address,
  );
  res.json({ success: true, message: "Wallet verification code sent." });
});

export const saveWalletAddress = handler(async (req, res) => {
  const user = await account(req);
  const address = wallet(req.body.address);
  await mongoose.connection.transaction(
    async (session) => {
      const valid = await consumeOtp({
        email: user.email,
        purpose: "withdrawal",
        code: req.body.otp,
        context: JSON.stringify(["pro-wallet", address]),
        session,
      });
      if (!valid)
        throw new InputError("Invalid or expired wallet verification code.");
      const updated = await User.updateOne(
        { _id: user._id, status: "active", isVerified: true },
        {
          $set: {
            withdrawalAddress: address,
            withdrawalAddressChangedAt: new Date(),
          },
          $inc: { proFinanceVersion: 1 },
        },
        { session },
      );
      if (!updated.matchedCount) throw new InputError("Account unavailable.");
      await AuditLog.create(
        [
          {
            userId: user._id,
            action: "Wallet Address Verified",
            details: { address },
            ipAddress: req.ip,
          },
        ],
        { session },
      );
    },
    { writeConcern: { w: "majority" }, readConcern: { level: "snapshot" } },
  );
  res.json({
    success: true,
    withdrawalAddress: address,
    message: "Wallet verified. Live withdrawals unlock in 24 hours.",
  });
});

export const requestWithdrawalOtp = handler(async (req, res) => {
  const user = await account(req);
  const mode = payoutMode(),
    units = amountUnits(req.body.amount),
    key = requestId(req);
  if (req.body.mode !== mode)
    throw new InputError("Payout mode changed. Refresh this page.");
  ready(user, mode);
  if ((user[balanceField(mode)] || 0) < units)
    throw new InputError("Insufficient available balance.");
  await throttleOtp(user._id);
  const code = await issueOtp({
    email: user.email,
    purpose: "withdrawal",
    userId: user._id,
    context: context(mode, units, user.withdrawalAddress!, key),
  });
  await sendOtpEmail(
    user.email,
    user.firstName,
    code,
    "withdrawal",
    mode.toUpperCase() +
      " withdrawal: " +
      formatUsdt(units) +
      " USDT to " +
      user.withdrawalAddress,
  );
  res.json({ success: true, message: "Withdrawal verification code sent." });
});

export const withdrawFunds = handler(async (req, res) => {
  const user = await account(req);
  const units = amountUnits(req.body.amount),
    key = requestId(req);
  const existing = await ProWithdrawal.findOne({
    userId: user._id,
    requestId: key,
  }).lean();
  if (existing) {
    if (existing.units !== units || existing.mode !== req.body.mode)
      throw new InputError(
        "Request ID already used for a different withdrawal.",
      );
    res.json({
      success: true,
      withdrawal: publicWithdrawal(existing),
      idempotent: true,
    });
    return;
  }
  const mode = payoutMode();
  if (req.body.mode !== mode)
    throw new InputError("Payout mode changed. Refresh this page.");
  ready(user, mode);
  const field = balanceField(mode);
  let result: any;
  try {
    await mongoose.connection.transaction(
      async (session) => {
        const valid = await consumeOtp({
          email: user.email,
          purpose: "withdrawal",
          code: req.body.otp,
          context: context(mode, units, user.withdrawalAddress!, key),
          session,
        });
        if (!valid)
          throw new InputError(
            "Invalid or expired withdrawal verification code.",
          );
        const debited = await User.updateOne(
          {
            _id: user._id,
            role: "ProTrader",
            status: "active",
            isVerified: true,
            withdrawalAddress: user.withdrawalAddress,
            withdrawalAddressChangedAt: user.withdrawalAddressChangedAt ?? null,
            [field]: { $gte: units },
          },
          { $inc: { [field]: -units, proFinanceVersion: 1 } },
          { session },
        );
        if (debited.modifiedCount !== 1)
          throw new InputError(
            "Balance or wallet changed. Refresh and request a new code.",
          );
        const rows = await ProWithdrawal.create(
          [
            {
              userId: user._id,
              requestId: key,
              units,
              mode,
              address: user.withdrawalAddress,
            },
          ],
          { session },
        );
        result = rows[0];
        await AuditLog.create(
          [
            {
              userId: user._id,
              action: "Pro Withdrawal Reserved",
              targetId: result._id,
              details: {
                units,
                mode,
                address: user.withdrawalAddress,
                requestId: key,
              },
              ipAddress: req.ip,
            },
          ],
          { session },
        );
      },
      { writeConcern: { w: "majority" }, readConcern: { level: "snapshot" } },
    );
  } catch (error) {
    // Covers duplicate requests and an ambiguous transaction commit response.
    const replay = await ProWithdrawal.findOne({
      userId: user._id,
      requestId: key,
    }).lean();
    if (!replay || replay.units !== units || replay.mode !== mode) throw error;
    result = replay;
  }
  res.status(202).json({
    success: true,
    withdrawal: publicWithdrawal(result),
    message:
      mode === "demo"
        ? "Demo withdrawal queued. No funds will be transferred."
        : "Withdrawal queued for TRON confirmation.",
  });
});

export const getEarnings = handler(async (req, res) => {
  await account(req);
  const current = page(req),
    limit = 20;
  const [result] = await Trade.aggregate([
    {
      $match: { tradeOrigin: "copy", status: "closed", tradeResult: "profit" },
    },
    {
      $lookup: {
        from: Trade.collection.name,
        localField: "sourceTradeId",
        foreignField: "_id",
        as: "source",
      },
    },
    { $match: { "source.userId": req.user, "source.tradeOrigin": "pro" } },
    { $sort: { closedAt: -1, _id: -1 } },
    {
      $facet: {
        count: [{ $count: "total" }],
        rows: [
          { $skip: (current - 1) * limit },
          { $limit: limit },
          {
            $lookup: {
              from: ProEarning.collection.name,
              localField: "_id",
              foreignField: "tradeId",
              as: "credit",
            },
          },
          {
            $project: {
              _id: 1,
              tradeId: 1,
              pair: 1,
              closedAt: 1,
              realizedPnl: 1,
              platformFee: 1,
              platformShare: 1,
              proTraderShare: 1,
              feeStatus: 1,
              proTraderCreditStatus: 1,
              mode: {
                $ifNull: [{ $arrayElemAt: ["$credit.mode", 0] }, "unallocated"],
              },
              sourceTradeId: 1,
            },
          },
        ],
      },
    },
  ]);
  res.json({
    success: true,
    rows: result?.rows || [],
    page: current,
    pages: Math.max(1, Math.ceil((result?.count[0]?.total || 0) / limit)),
  });
});

export const getWithdrawals = handler(async (req, res) => {
  await account(req);
  const current = page(req),
    limit = 20;
  const [result] = await ProWithdrawal.aggregate([
    { $match: { userId: req.user } },
    {
      $project: {
        _id: 1,
        units: 1,
        mode: 1,
        address: 1,
        status: 1,
        transactionId: 1,
        createdAt: 1,
        completedAt: 1,
      },
    },
    {
      $unionWith: {
        coll: AuditLog.collection.name,
        pipeline: [
          { $match: { userId: req.user, action: "Withdrawal Executed" } },
          {
            $project: {
              _id: 1,
              amount: { $toString: "$details.amount" },
              mode: { $literal: "live" },
              address: "$details.destinationAddress",
              transactionId: "$details.transactionId",
              status: { $literal: "LEGACY_SUBMITTED" },
              createdAt: 1,
            },
          },
        ],
      },
    },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $facet: {
        count: [{ $count: "total" }],
        rows: [{ $skip: (current - 1) * limit }, { $limit: limit }],
      },
    },
  ]);
  res.json({
    success: true,
    rows: (result?.rows || []).map((row: any) => ({
      ...row,
      amount: row.amount || formatUsdt(row.units),
    })),
    page: current,
    pages: Math.max(1, Math.ceil((result?.count[0]?.total || 0) / limit)),
  });
});

export const getWithdrawalRequest = handler(async (req, res) => {
  await account(req);
  const key = req.params.requestId;
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(key))
    throw new InputError("Invalid request ID.");
  const row = await ProWithdrawal.findOne({
    userId: req.user,
    requestId: key,
  }).lean();
  res.json({ success: true, withdrawal: row ? publicWithdrawal(row) : null });
});
