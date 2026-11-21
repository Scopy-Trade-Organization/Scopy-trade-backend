import type { ClientSession, Types } from "mongoose";
import User from "../models/userModel.js";

// All callers use a MongoDB transaction. Outstanding network costs are paid
// before funds become withdrawable; accounting never creates a negative balance.
export async function adjustProBalance(userId: Types.ObjectId, credit: number, charge: number, session: ClientSession, requireProTrader = false) {
  const user = await User.findOne({ _id: userId, ...(requireProTrader ? { role: "ProTrader" } : {}) }).session(session).lean();
  if (!user) throw new Error("Pro balance unavailable.");
  const available = (user.proBalanceUnits ?? 0) + credit;
  const owed = (user.proNetworkFeeOwedUnits ?? 0) + charge;
  if (![user.proBalanceUnits ?? 0, user.proNetworkFeeOwedUnits ?? 0, available, owed, credit, charge].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Unsupported pro balance precision.");
  await User.updateOne({ _id: userId }, { $set: {
    proBalanceUnits: Math.max(0, available - owed),
    proNetworkFeeOwedUnits: Math.max(0, owed - available),
  } }, { session });
}
