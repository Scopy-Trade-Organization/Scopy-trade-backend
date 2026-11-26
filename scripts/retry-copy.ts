import "dotenv/config";
import { parseArgs } from "node:util";
import mongoose from "mongoose";
import { CopyExecution, CopyExecutionLock, CopySubscription } from "../src/models/copySubscriptionModel.js";
import { Trade } from "../src/models/tradeModel.js";
import User from "../src/models/userModel.js";
import { ExchangeConnection } from "../src/models/exchangeConnectionModel.js";
import { drainCopyQueue } from "../src/services/automaticCopyService.js";
import { getExchangeMode } from "../src/services/exchangeEnvironment.js";
import { getTradeMonitorService } from "../src/services/tradeMonitorService.js";

// This reason is raised during planning, before any order attempt is saved.
const reason = "Bybit maintenance deduction is unavailable or invalid.";
const { values } = parseArgs({ options: {
  "execution-id": { type: "string" },
  pair: { type: "string", default: "LINKUSDT" },
  execute: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} });

async function main() {
  if (values.help) {
    console.log("Preview: npx tsx scripts/retry-copy.ts --pair LINKUSDT");
    console.log("Retry:   npx tsx scripts/retry-copy.ts --execution-id <ID> --execute");
    console.log("Loads .env. Executes only the selected copy using the local source code.");
    return;
  }
  if (values["execution-id"] && !/^[a-f\d]{24}$/i.test(values["execution-id"])) throw new Error("Invalid execution ID.");
  if (values.execute && !values["execution-id"]) throw new Error("--execute requires exactly one --execution-id from the preview.");
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required in .env.");
  // Require an explicit setting to avoid accidentally using the local testnet default.
  if (values.execute && !["live", "testnet"].includes(process.env.EXCHANGE_MODE?.trim().toLowerCase() ?? "")) {
    throw new Error("Set EXCHANGE_MODE explicitly to live or testnet, matching the original trade.");
  }
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 15_000 });
  console.log(`Database: ${mongoose.connection.name}; exchange mode: ${getExchangeMode()}`);
  if (!values.execute) {
    const sourceIds = await Trade.find({ tradeOrigin: "pro", pair: values.pair?.toUpperCase() }).distinct("_id");
    const jobs = await CopyExecution.find({ status: "failed", reason, sourceTradeId: { $in: sourceIds },
      ...(values["execution-id"] ? { _id: values["execution-id"] } : {}),
    }).sort({ createdAt: -1 }).limit(50).lean();
    console.table(await Promise.all(jobs.map(async job => {
      const copier = await User.findById(job.copierId).select("email").lean();
      const source = await Trade.findById(job.sourceTradeId).select("pair status").lean();
      return { executionId: String(job._id), copier: copier?.email, pair: source?.pair,
        sourceStatus: source?.status, failedAt: job.completedAt, reason: job.reason };
    })));
    console.log("Preview only. Select the intended copier's executionId and rerun with --execution-id <ID> --execute.");
    return;
  }
  const job = await CopyExecution.findOne({ _id: values["execution-id"], status: "failed", reason }).lean();
  if (!job) throw new Error("No matching failed deduction copy. This script only retries this known pre-order failure.");
  const source = await Trade.findById(job.sourceTradeId).lean();
  if (!source || source.tradeOrigin !== "pro" || !["pending", "filled"].includes(source.status) || source.protectionStatus !== "confirmed") {
    throw new Error("The source trade is closed, unavailable or lacks confirmed protection. Retry refused.");
  }
  const subscription = await CopySubscription.findOne({ _id: job.subscriptionId, active: true,
    copierId: job.copierId, proTraderId: source.userId, exchangeConnectionId: job.exchangeConnectionId,
    startedAt: { $lte: source.createdAt },
  }).lean();
  if (!subscription) throw new Error("The original subscription is no longer active. Retry refused.");
  const connection = await ExchangeConnection.findOne({ _id: job.exchangeConnectionId, userId: job.copierId, isActive: true, exchange: "bybit" }).lean();
  if (!connection) throw new Error("The original Bybit connection is unavailable.");
  if (await Trade.exists({ sourceTradeId: job.sourceTradeId, exchangeConnectionId: job.exchangeConnectionId })) {
    throw new Error("A copy trade record already exists. Review it before retrying; no record or lock was removed.");
  }
  if (await CopyExecutionLock.exists({ connectionId: job.exchangeConnectionId }) ||
      (connection.executionLockUntil && connection.executionLockUntil > new Date())) {
    throw new Error("This account is locked for execution or review. Retry refused.");
  }
  const updated = await CopyExecution.updateOne({ _id: job._id, status: "failed", reason }, {
    $set: { status: "queued", reason: null, startedAt: null, completedAt: null, availableAt: new Date() },
  });
  if (updated.modifiedCount !== 1) throw new Error("Execution changed concurrently. No retry queued by this script.");
  console.log(`Retrying ${source.pair}, execution ${job._id}, using local code. This can place a real order in live mode.`);
  await drainCopyQueue({ executionId: String(job._id) });
  const result = await CopyExecution.findById(job._id).lean();
  console.log({ executionId: String(job._id), status: result?.status, reason: result?.reason });
  if (result?.status !== "completed") process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  // Do not print raw database/transport errors, which can include credentials.
  console.error(error instanceof mongoose.Error || (error instanceof Error && error.name.startsWith("Mongo"))
    ? "Database operation failed. Verify MONGO_URI and database access."
    : error instanceof Error ? error.message : "Retry failed.");
  process.exitCode = 1;
} finally {
  if (values.execute) await getTradeMonitorService().shutdown();
  await mongoose.disconnect();
}
