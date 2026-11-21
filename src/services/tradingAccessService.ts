import type { Types } from "mongoose";
import User from "../models/userModel.js";

export const TRADING_NOT_ENABLED_MESSAGE =
  "Trading is not enabled for this account. New trades and copy subscriptions are available to live accounts only. You can still manage existing positions and stop copying.";

// Read current database state: neither a request payload nor a cached token grants trading access.
export async function hasLiveTradingAccess(userId: Types.ObjectId): Promise<boolean> {
  return !!await User.exists({ _id: userId, status: "live" });
}
