import { Request, Response } from "express";
import { Signal } from "../models/signalModel.js";
import { Trade } from "../models/tradeModel.js";
import mongoose from "mongoose";
import { withCurrentMarketPrices } from "../services/tradeMarketPriceService.js";

export async function getActiveProTrades(req: Request, res: Response) {
  try {
    const userId = req.user as mongoose.Types.ObjectId;
    const trades = await Trade.find({
      tradeOrigin: "pro",
      status: { $in: ["pending", "filled"] },
    })
      .populate("userId", "firstName lastName traderID profilePhoto")
      .populate("signalId", "notes")
      .populate("exchangeConnectionId", "exchange label")
      .sort({ createdAt: -1 })
      .lean();

    const sourceIds = trades.map((trade) => trade._id);
    const [myCopies, copierCounts] = await Promise.all([
      Trade.find({
        userId,
        tradeOrigin: "copy",
        sourceTradeId: { $in: sourceIds },
      })
        .select("sourceTradeId status tradeResult")
        .lean(),
      Trade.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
        {
          $match: {
            tradeOrigin: "copy",
            sourceTradeId: { $in: sourceIds },
          },
        },
        { $group: { _id: "$sourceTradeId", count: { $sum: 1 } } },
      ]),
    ]);

    const myCopyBySource = new Map(
      myCopies.map((trade) => [String(trade.sourceTradeId), trade]),
    );
    const countBySource = new Map(
      copierCounts.map((entry) => [String(entry._id), entry.count]),
    );

    return res.status(200).json({
      success: true,
      trades: await withCurrentMarketPrices(trades.map((trade) => ({
        ...trade,
        copiers: countBySource.get(String(trade._id)) ?? 0,
        myTrade: myCopyBySource.get(String(trade._id)) ?? null,
      }))),
    });
  } catch (err) {
    console.error("[getActiveProTrades]", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch active pro trades.",
    });
  }
}

export async function getProTradeById(req: Request, res: Response) {
  try {
    const { tradeId } = req.params;
    if (!mongoose.isValidObjectId(tradeId)) {
      return res.status(400).json({ success: false, message: "Invalid trade ID." });
    }

    const trade = await Trade.findOne({
      _id: tradeId,
      tradeOrigin: "pro",
      status: { $in: ["pending", "filled"] },
    })
      .populate("userId", "firstName lastName traderID profilePhoto")
      .populate("signalId", "notes")
      .populate("exchangeConnectionId", "exchange label")
      .lean();

    if (!trade) {
      return res.status(404).json({ success: false, message: "Active pro trade not found." });
    }

    const [pricedTrade] = await withCurrentMarketPrices([trade]);
    return res.status(200).json({ success: true, trade: pricedTrade });
  } catch (err) {
    console.error("[getProTradeById]", err);
    return res.status(500).json({ success: false, message: "Failed to fetch trade." });
  }
}
//GET  all active signals.
export async function getActiveSignals(req: Request, res: Response) {
  try {
    const userId = req.user as mongoose.Types.ObjectId;

    const signals = await Signal.find({ status: "active" })
      .populate("trader", "firstName lastName traderID profilePhoto")
      .sort({ createdAt: -1 })
      .lean();

    if (!signals.length) {
      return res.status(200).json({ signals: [] });
    }

    /* Attach the user's own trade (if any) to each signal so the UI can
     disable the "Copy Trade" button for signals already being copied. */
    const signalIds = signals.map((s) => s._id);
    const userTrades = await Trade.find({
      userId,
      signalId: { $in: signalIds },
    })
      .select("signalId status tradeResult")
      .lean();

    const tradeBySignal = new Map(
      userTrades.map((t) => [t.signalId.toString(), t]),
    );

    const enriched = signals.map((signal) => ({
      ...signal,
      myTrade: tradeBySignal.get(signal._id.toString()) ?? null,
    }));

    return res.status(200).json({ signals: enriched });
  } catch (err) {
    console.error("[getActiveSignals]", err);
    return res.status(500).json({ message: "Failed to fetch active signals." });
  }
}

// Return a single signal by ID with enriched trader info.
export async function getSignalById(req: Request, res: Response) {
  try {
    const { signalId } = req.params;

    if (!mongoose.isValidObjectId(signalId)) {
      return res.status(400).json({ message: "Invalid signal ID." });
    }

    const signal = await Signal.findById(signalId)
      .populate("trader", "firstName lastName traderID profilePhoto")
      .lean();

    if (!signal) {
      return res.status(404).json({ message: "Signal not found." });
    }

    return res.status(200).json({ signal });
  } catch (err) {
    console.error("[getSignalById]", err);
    return res.status(500).json({ message: "Failed to fetch signal." });
  }
}
