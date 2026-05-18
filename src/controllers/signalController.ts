import { Request, Response } from "express";
import { Signal } from "../middleware/signalModel.js";

export const getAllSignals = async (req: Request, res: Response) => {
  try {
    const signals = await Signal.find().sort({ createdAt: -1 });

    return res.status(200).json({
      status: "success",
      results: signals.length,
      data: {
        signals,
      },
    });
  } catch (err: any) {
    console.error("Error fetching signals:", err);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch signals",
      details: err.message,
    });
  }
};
