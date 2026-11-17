import mongoose from "mongoose";
import { usdtUnits } from "../helpers/usdt.js";

// Converts old financial records once; source collections remain as backups.
export async function migrateFinancialRecords() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Connect MongoDB before migrating financial records.");
  const transactions = db.collection("transactions");
  const fields = ["userId", "type", "units", "status", "tradeId", "tradeIds", "requestId", "address", "memo", "transactionId", "senderAddress", "signedTransaction", "expiresAt", "completedAt", "lastError", "createdAt", "updatedAt"];
  for (const [collection, type] of [["proearnings", "earning"], ["prowithdrawals", "withdrawal"], ["settlements", "settlement"], ["transactions", null]] as const) {
    for await (const original of db.collection(collection).find()) {
      if (original.mode === "demo" || original.simulated || original.fundingMode === "demo") {
        // Preserve old fake-money records separately; never make them payable as real USDT.
        if (collection === "transactions") {
          await db.collection("legacy_demo_transactions").updateOne({ _id: original._id }, { $setOnInsert: original }, { upsert: true });
          await transactions.deleteOne({ _id: original._id });
        }
        continue;
      }
      const source: Record<string, any> = { ...original, type: type || original.type };
      source.units ??= usdtUnits(source.amount || "0");
      source.address ??= source.destinationAddress;
      source.transactionId ??= source.blockchainTransactionId;
      source.lastError ??= source.error;
      if (source.type === "earning") source.status = "COMPLETED";
      if (["PROCESSING", "SUBMITTED"].includes(source.status)) source.status = "REVIEW";
      if (source.status === "CONFIRMED") source.status = "COMPLETED";
      const row: Record<string, any> = { _id: source._id };
      for (const field of fields) if (source[field] !== undefined && source[field] !== null) row[field] = source[field];
      if (source.batchId && source.type === "settlement") {
        await db.collection("trades").updateMany({ settlementBatchId: source.batchId }, { $set: { settlementBatchId: String(source._id) } });
      }
      const existing = await transactions.findOne({ _id: row._id });
      if (existing && existing.type !== row.type) throw new Error("Financial migration ID collision.");
      // Existing unified records are normalized; legacy sources never overwrite current state.
      if (collection === "transactions") await transactions.replaceOne({ _id: row._id }, row);
      else await transactions.updateOne({ _id: row._id }, { $setOnInsert: row }, { upsert: true });
    }
  }
  await db.collection("users").updateMany({ proBalanceUnits: { $exists: false }, proLiveUnits: { $exists: true } }, [{ $set: { proBalanceUnits: "$proLiveUnits" } }]);
  await db.collection("users").updateMany({}, { $unset: { proLiveUnits: "", proDemoUnits: "", proDemoGranted: "" } });
  // Demo rank credits must be verified again before becoming actual bonuses.
  await db.collection("rankawards").updateMany({ mode: "demo" }, { $set: { status: "pending", verifiedBy: null, verifiedAt: null } });
  await db.collection("rankawards").updateMany({}, { $unset: { mode: "" } });
  for await (const row of db.collection("copynotifications").find()) {
    await db.collection("notifications").updateOne({ _id: row._id }, { $setOnInsert: { ...row, kind: "copy_failure" } }, { upsert: true });
  }
}
