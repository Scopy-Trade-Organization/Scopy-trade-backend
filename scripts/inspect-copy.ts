import "dotenv/config";
import { parseArgs } from "node:util";
import mongoose from "mongoose";
import { CopyExecution } from "../src/models/copySubscriptionModel.js";
import { Trade } from "../src/models/tradeModel.js";
import { ExchangeConnection } from "../src/models/exchangeConnectionModel.js";

const { values } = parseArgs({ options: {
  "execution-id": { type: "string" }, "source-trade-id": { type: "string" },
  pair: { type: "string" }, help: { type: "boolean" },
} });

async function main() {
  if (values.help) {
    console.log("Read-only: npx tsx scripts/inspect-copy.ts --pair LINKUSDT");
    console.log("Or use --execution-id <ID> / --source-trade-id <ID>. Shows up to 20 recent copies.");
    return;
  }
  if (!values["execution-id"] && !values["source-trade-id"] && !values.pair) throw new Error("Specify --pair, --execution-id or --source-trade-id.");
  for (const id of [values["execution-id"], values["source-trade-id"]]) {
    if (id && !/^[a-f\d]{24}$/i.test(id)) throw new Error("Invalid ID: expected a 24-character MongoDB ObjectId.");
  }
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required.");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15_000 });
  const sourceIds = values.pair ? await Trade.find({ tradeOrigin: "pro", pair: values.pair.toUpperCase() }).distinct("_id") : undefined;
  const jobs = await CopyExecution.find({
    ...(values["execution-id"] ? { _id: values["execution-id"] } : {}),
    ...(values["source-trade-id"] ? { sourceTradeId: values["source-trade-id"] } : sourceIds ? { sourceTradeId: { $in: sourceIds } } : {}),
  }).select("sourceTradeId status reason failureCode sourceProtectionChecks sourceProtectionSnapshot createdAt startedAt availableAt completedAt").sort({ createdAt: -1 }).limit(20).lean();
  const reports = await Promise.all(jobs.map(async job => {
    const source = await Trade.findById(job.sourceTradeId).select("pair status protectionStatus protectionCheckedAt protectionError protectionDiagnostics exchangeConnectionId exchangeOrderId createdAt updatedAt").lean();
    const connection = source ? await ExchangeConnection.findById(source.exchangeConnectionId).select("exchange").lean() : null;
    return { execution: job, currentSource: source, sourceExchange: connection?.exchange ?? null };
  }));
  console.log(JSON.stringify({ database: mongoose.connection.name, reports }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof mongoose.Error || (error instanceof Error && error.name.startsWith("Mongo"))
    ? "Database operation failed. Verify MONGO_URI and database access."
    : error instanceof Error ? error.message : "Inspection failed.");
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
