import { quoteWithdrawalFee } from "../services/withdrawalFeeService.js";
import { Earning } from "../models/earningModel.js";
import { Transaction } from "../models/transactionModel.js";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import rateLimit from "express-rate-limit";
import User from "../models/userModel.js";
import AuditLog from "../models/auditLogModel.js";
import { Trade } from "../models/tradeModel.js";
import { RankAward } from "../models/rankModel.js";
import { isValidTronAddress } from "../helpers/tronAddress.js";
import { formatUsdt, usdtUnits } from "../helpers/usdt.js";
import { consumeOtp, issueOtp } from "../services/otpService.js";
import { sendOtpEmail } from "../services/emailService.js";
import {
  liveClient,
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

export function withdrawalOtpContext(units: number, address: string, key: string, quote: any) {
  return JSON.stringify(["pro-withdrawal", units, address, key, quote.payoutUnits,
    quote.networkFeeReserveUnits, quote.feeLimitSun, quote.bandwidthSunPerByte,
    quote.trxPriceUnits, new Date(quote.quoteExpiresAt).toISOString()]);
}

function ready(user: Awaited<ReturnType<typeof account>>) {
  wallet(user.withdrawalAddress);
  liveClient();
  if (user.proNetworkFeeOwedUnits > 0) throw new InputError("Outstanding network fees must be covered before withdrawing.");
  if (!user.withdrawalAddressChangedAt || Date.now() - user.withdrawalAddressChangedAt.getTime() < 24 * 60 * 60_000) {
    throw new InputError("Withdrawals unlock 24 hours after verifying your wallet.");
  }
}

function page(req: Request) {
  const value = Number(req.query.page || 1);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000)
    throw new InputError("Invalid page.");
  return value;
}

export function publicWithdrawal(row: any) {
  return {
    _id: row._id,
    requestId: row.requestId,
    amount: formatUsdt(row.units),
    payoutAmount: formatUsdt(row.payoutUnits ?? row.units),
    networkFeeReserve: formatUsdt(row.networkFeeReserveUnits ?? 0),
    networkFee: row.networkFeeUnits === undefined ? null : formatUsdt(row.networkFeeUnits),
    refundedAmount: row.refundUnits === undefined ? null : formatUsdt(row.refundUnits),
    additionalNetworkFee: formatUsdt(row.feeOverrunUnits ?? 0),
    quoteExpiresAt: row.quoteExpiresAt ?? null,
    address: row.address,
    status: row.status,
    transactionId: row.transactionId,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    fundsReserved: ["QUEUED", "SIGNED", "REVIEW"].includes(row.status),
    lastError: row.status === "REVIEW"
      ? "Your withdrawal is under review because the blockchain result could not yet be confirmed. Funds remain reserved."
      : row.status === "FAILED"
        ? "Transfer failed or was cancelled. Unsent funds were refunded after any consumed network fee."
        : null,
  };
}

export const getFinanceSummary = handler(async (req, res) => {
  const user = await account(req);
  const [earned, reserved, bonuses] = await Promise.all([
    Earning.aggregate([{ $match: { userId: req.user, status: "COMPLETED" } },
      { $group: { _id: null, units: { $sum: "$units" } } },
    ]),
    Transaction.aggregate([{ $match: { type: "withdrawal" } },
      {
        $match: {
          userId: req.user,
          status: { $in: ["QUEUED", "SIGNED", "REVIEW"] },
        },
      },
      { $group: { _id: null, units: { $sum: "$units" } } },
    ]),
    RankAward.aggregate([
      { $match: { userId: req.user, status: "credited" } },
      { $group: { _id: null, amount: { $sum: "$bonus" } } },
    ]),
  ]);
  res.json({
    success: true,
    accountId: String(user._id),
    available: formatUsdt(user.proBalanceUnits || 0),
    networkFeeOwed: formatUsdt(user.proNetworkFeeOwedUnits || 0),
    earned: formatUsdt((earned[0]?.units || 0) + Math.round((bonuses[0]?.amount || 0) * 1_000_000)),
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
  const units = amountUnits(req.body.amount),
    key = requestId(req);
  ready(user);
  if ((user.proBalanceUnits || 0) < units)
    throw new InputError("Insufficient available balance.");
  let quote = await Transaction.findOne({ type: "withdrawal", userId: user._id, requestId: key }).lean();
  if (quote && quote.units !== units) throw new InputError("Request ID already used for a different withdrawal.");
  if (quote && quote.status !== "QUOTED") throw new InputError("This withdrawal was already submitted. Refresh its status.");
  if (!quote || quote.address !== user.withdrawalAddress || !quote.quoteExpiresAt || quote.quoteExpiresAt.getTime() <= Date.now()) {
    let feeQuote;
    try { feeQuote = await quoteWithdrawalFee(units, user.withdrawalAddress!); }
    catch (error) { throw new InputError(error instanceof Error && error.message === "Withdrawal amount must exceed its network fee reserve." ? error.message : "Network fees cannot be quoted right now. Please try again later."); }
    quote = await Transaction.findOneAndUpdate({ type: "withdrawal", userId: user._id, requestId: key, status: "QUOTED" },
      { $set: { units, address: user.withdrawalAddress, ...feeQuote } }, { upsert: true, new: true, runValidators: true }).lean();
  }
  if (!quote) throw new Error("Withdrawal quote unavailable.");
  await throttleOtp(user._id);
  const code = await issueOtp({
    email: user.email,
    purpose: "withdrawal",
    userId: user._id,
    context: withdrawalOtpContext(units, user.withdrawalAddress!, key, quote),
  });
  await sendOtpEmail(
    user.email,
    user.firstName,
    code,
    "withdrawal",
    "Withdrawal: " +
      formatUsdt(units) +
      " USDT to " +
      user.withdrawalAddress + ". Total debit: " + formatUsdt(units) +
      " USDT; network fee reserve: " + formatUsdt(quote.networkFeeReserveUnits!) +
      " USDT; wallet receives: " + formatUsdt(quote.payoutUnits!) +
      " USDT. Unused reserve is returned to your balance after confirmation. Failed transfers may still consume network fees.",
  );
  res.json({ success: true, message: "Withdrawal verification code sent.", quote: publicWithdrawal(quote) });
});

export const withdrawFunds = handler(async (req, res) => {
  const user = await account(req);
  const units = amountUnits(req.body.amount),
    key = requestId(req);
  const existing = await Transaction.findOne({ type: "withdrawal",
    userId: user._id,
    requestId: key,
  }).lean();
  if (existing && existing.units !== units) throw new InputError("Request ID already used for a different withdrawal.");
  if (existing && existing.status !== "QUOTED") {
    res.json({
      success: true,
      withdrawal: publicWithdrawal(existing),
      idempotent: true,
    });
    return;
  }
  ready(user);
  const field = "proBalanceUnits";
  let result: any;
  try {
    await mongoose.connection.transaction(
      async (session) => {
        const quote = await Transaction.findOne({ type: "withdrawal", userId: user._id, requestId: key, status: "QUOTED",
          units, address: user.withdrawalAddress, quoteExpiresAt: { $gt: new Date() } }).session(session).lean();
        if (!quote?.payoutUnits || quote.networkFeeReserveUnits === undefined) throw new InputError("Request a new network fee quote and verification code.");
        const valid = await consumeOtp({
          email: user.email,
          purpose: "withdrawal",
          code: req.body.otp,
          context: withdrawalOtpContext(units, user.withdrawalAddress!, key, quote),
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
            $or: [{ proNetworkFeeOwedUnits: { $lte: 0 } }, { proNetworkFeeOwedUnits: { $exists: false } }],
          },
          { $inc: { [field]: -units } },
          { session },
        );
        if (debited.modifiedCount !== 1)
          throw new InputError(
            "Balance or wallet changed. Refresh and request a new code.",
          );
        result = await Transaction.findOneAndUpdate({ _id: quote._id, status: "QUOTED" },
          { $set: { status: "QUEUED" } }, { new: true, session });
        if (!result) throw new InputError("Withdrawal quote changed. Refresh and try again.");
        await AuditLog.create(
          [
            {
              userId: user._id,
              action: "Pro Withdrawal Reserved",
              targetId: result._id,
              details: {
                units,
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
    const replay = await Transaction.findOne({ type: "withdrawal",
      userId: user._id,
      requestId: key,
    }).lean();
    if (!replay || replay.status === "QUOTED" || replay.units !== units) throw error;
    result = replay;
  }
  res.status(202).json({
    success: true,
    withdrawal: publicWithdrawal(result),
    message: "Withdrawal queued for TRON confirmation.",
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
    {
      $lookup: {
        from: Earning.collection.name,
        localField: "_id",
        foreignField: "tradeId",
        pipeline: [{ $match: { userId: req.user, status: "COMPLETED" } }],
        as: "earning",
      },
    },
    { $sort: { closedAt: -1, _id: -1 } },
    {
      $facet: {
        count: [{ $count: "total" }],
        rows: [
          { $skip: (current - 1) * limit },
          { $limit: limit },
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
              sourceTradeId: 1,
              earning: { $arrayElemAt: ["$earning", 0] },
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
  const [result] = await Transaction.aggregate([{ $match: { type: "withdrawal", status: { $ne: "QUOTED" } } },
    { $match: { userId: req.user } },
    {
      $project: {
        _id: 1,
        units: 1,
        address: 1,
        status: 1,
        transactionId: 1,
        createdAt: 1,
        completedAt: 1,
        requestId: 1,
        payoutUnits: 1, networkFeeReserveUnits: 1, networkFeeUnits: 1,
        refundUnits: 1, feeOverrunUnits: 1, quoteExpiresAt: 1,
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
    rows: (result?.rows || []).map(publicWithdrawal),
    page: current,
    pages: Math.max(1, Math.ceil((result?.count[0]?.total || 0) / limit)),
  });
});

export const getWithdrawalRequest = handler(async (req, res) => {
  await account(req);
  const key = req.params.requestId;
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(key))
    throw new InputError("Invalid request ID.");
  const row = await Transaction.findOne({ type: "withdrawal",
    userId: req.user,
    requestId: key, status: { $ne: "QUOTED" },
  }).lean();
  res.json({ success: true, withdrawal: row ? publicWithdrawal(row) : null });
});
