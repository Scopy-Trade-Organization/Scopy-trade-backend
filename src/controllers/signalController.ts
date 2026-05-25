import { Request, Response } from "express";
import { Signal } from "../middleware/signalModel.js";

export const getAllSignals = async (req: Request, res: Response) => {
  try {
    const { status, sort } = req.query;
    const filterQuery: any = {};

    // Filter by status: active maps to "active", closed maps to "expired"
    if (status) {
      if (status === "active") {
        filterQuery.status = "active";
      } else if (status === "closed" || status === "expired") {
        filterQuery.status = "expired";
      }
    }

    // Default sorting is by createdAt descending (-1)
    let sortOption: any = { createdAt: -1 };
    if (sort === "createdAtAsc") {
      sortOption = { createdAt: 1 };
    } else if (sort === "createdAtDesc") {
      sortOption = { createdAt: -1 };
    }

    const signals = await Signal.find(filterQuery).sort(sortOption);

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
