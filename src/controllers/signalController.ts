import { Request, Response } from "express";
import { Signal } from "../models/signalModel.js";

export const getAllSignals = async (req: Request, res: Response) => {
  try {
    const { status, page = 1 } = req.query;

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
      .skip(skip);

    const total = await Signal.countDocuments(filter);

    return res.status(200).json({
      success: true,
      message: "Signals retrieved successfully",
      signals,
      page: currentPage,
      limit,
      pageSize: signals.length,
      pages: Math.ceil(total / limit),
      total,
    });
  } catch (error) {
    console.error("Error fetching signals:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};
