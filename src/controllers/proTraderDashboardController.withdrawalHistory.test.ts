import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Request, Response } from "express";
import User from "../models/userModel.js";
import AuditLog from "../models/auditLogModel.js";
import { getWithdrawalHistory } from "./proTraderDashboardController.js";

// This is the first DB-backed test in the repo — everything else mocks
// http calls at the service layer. There's no real database to hit in CI,
// so we spin up a real (in-memory) MongoDB instead of mocking Mongoose
// itself, which would mean re-implementing query/sort/skip/limit semantics
// by hand and trusting that reimplementation matches Mongo's actual
// behaviour.
let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await AuditLog.deleteMany({});
});

function createUser(overrides: Partial<{ email: string; traderID: string }> = {}) {
  return User.create({
    firstName: "Test",
    lastName: "Trader",
    email: overrides.email ?? `trader-${Date.now()}-${Math.random()}@example.com`,
    traderID: overrides.traderID ?? `TID-${Date.now()}-${Math.random()}`,
    role: "Pro Trader",
  });
}

/** Minimal Request/Response doubles — just enough for this controller. */
function createReqRes(userId: string, query: Record<string, unknown> = {}) {
  const req = { user: userId, query } as unknown as Request;

  let statusCode = 0;
  let body: any = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
  } as unknown as Response;

  return {
    req,
    res,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
}

function logWithdrawal(
  userId: string,
  {
    amount,
    transactionId,
    destinationAddress = "TXbn5m37PT8ZhTgfsfmZm12EN76bwuxSj7",
    timestamp,
  }: {
    amount: number;
    transactionId: string;
    destinationAddress?: string;
    timestamp: Date;
  },
) {
  return AuditLog.create({
    userId,
    action: "Withdrawal Executed",
    details: { amount, destinationAddress, transactionId, remainingBalance: 0 },
    timestamp,
  });
}

test("returns only the requesting user's completed withdrawals, newest first", async () => {
  const userA = await createUser();
  const userB = await createUser();

  const base = Date.now();
  await logWithdrawal(String(userA._id), {
    amount: 10,
    transactionId: "tx-oldest",
    timestamp: new Date(base - 2000),
  });
  await logWithdrawal(String(userA._id), {
    amount: 20,
    transactionId: "tx-middle",
    timestamp: new Date(base - 1000),
  });
  await logWithdrawal(String(userA._id), {
    amount: 30,
    transactionId: "tx-newest",
    timestamp: new Date(base),
  });

  // Should never show up: different user, and a non-withdrawal action.
  await logWithdrawal(String(userB._id), {
    amount: 999,
    transactionId: "tx-other-user",
    timestamp: new Date(base),
  });
  await AuditLog.create({
    userId: userA._id,
    action: "Wallet Address Updated",
    details: { address: "T..." },
    timestamp: new Date(base),
  });

  const { req, res, statusCode, body } = createReqRes(String(userA._id));
  await getWithdrawalHistory(req, res);

  assert.equal(statusCode, 200);
  assert.equal(body.success, true);
  assert.equal(body.total, 3);
  assert.equal(body.page, 1);
  assert.equal(body.limit, 10);
  assert.equal(body.pages, 1);
  assert.equal(body.withdrawals.length, 3);

  // Newest first.
  assert.deepEqual(
    body.withdrawals.map((w: any) => w.transactionId),
    ["tx-newest", "tx-middle", "tx-oldest"],
  );

  const first = body.withdrawals[0];
  assert.equal(first.amount, 30);
  assert.equal(first.status, "COMPLETED");
  assert.equal(first.destinationAddress, "TXbn5m37PT8ZhTgfsfmZm12EN76bwuxSj7");
  assert.ok(first.id);
  assert.ok(first.date);
});

test("paginates with 10 per page", async () => {
  const user = await createUser();
  const base = Date.now();

  for (let i = 0; i < 15; i++) {
    await logWithdrawal(String(user._id), {
      amount: i,
      transactionId: `tx-${i}`,
      timestamp: new Date(base - i * 1000),
    });
  }

  const page1 = createReqRes(String(user._id), { page: "1" });
  await getWithdrawalHistory(page1.req, page1.res);
  assert.equal(page1.body.withdrawals.length, 10);
  assert.equal(page1.body.total, 15);
  assert.equal(page1.body.pages, 2);
  assert.equal(page1.body.page, 1);

  const page2 = createReqRes(String(user._id), { page: "2" });
  await getWithdrawalHistory(page2.req, page2.res);
  assert.equal(page2.body.withdrawals.length, 5);
  assert.equal(page2.body.page, 2);

  // No overlap between pages.
  const page1Ids = page1.body.withdrawals.map((w: any) => w.transactionId);
  const page2Ids = page2.body.withdrawals.map((w: any) => w.transactionId);
  assert.equal(page1Ids.filter((id: string) => page2Ids.includes(id)).length, 0);
});

test("returns an empty list for a user with no withdrawals", async () => {
  const user = await createUser();

  const { req, res, body, statusCode } = createReqRes(String(user._id));
  await getWithdrawalHistory(req, res);

  assert.equal(statusCode, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.withdrawals, []);
  assert.equal(body.total, 0);
});
