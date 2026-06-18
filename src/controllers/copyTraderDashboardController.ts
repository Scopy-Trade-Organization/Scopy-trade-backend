import { Request, Response } from "express";
import { Signal } from "../models/signalModel.js";
import { Trade } from "../models/tradeModel.js";
import mongoose from "mongoose";

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
