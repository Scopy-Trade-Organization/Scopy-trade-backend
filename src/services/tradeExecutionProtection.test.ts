import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Signal } from "../models/signalModel.js";
import { Trade } from "../models/tradeModel.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import { CopyExecution, CopyExecutionLock, CopySubscription } from "../models/copySubscriptionModel.js";
import User from "../models/userModel.js";
import { drainCopyQueue } from "./automaticCopyService.js";
import { executeTrade } from "./tradeExecutionService.js";
import { clearContractRulesCache } from "./tradeService.js";
import { http, encryptCredentials } from "./exchangeConnectionService.js";
import { TradeMonitorService, getTradeMonitorService } from "./tradeMonitorService.js";

describe("Trade Execution Protection & Safeguards", () => {
  let mongoServer: MongoMemoryServer;
  const originalEnv = { ...process.env };
  const TEST_KEY_HEX =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  beforeEach(async () => {
    process.env.EXCHANGE_ENCRYPTION_KEY = TEST_KEY_HEX;
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
    mock.method(getTradeMonitorService(), "startMonitoring", async () => {});
  });

  afterEach(async () => {
    await getTradeMonitorService().shutdown();
    mock.restoreAll();
    clearContractRulesCache();
    process.env = { ...originalEnv };
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  it("verifies server-side available balance and rejects when available funds cannot be verified", async () => {
    const userId = new mongoose.Types.ObjectId();
    const enc = encryptCredentials("bybit", {
      apiKey: "test-key",
      apiSecret: "test-secret",
    });

    const connection = await ExchangeConnection.create({
      userId,
      exchange: "bybit",
      encryptedApiKey: enc.apiKey,
      encryptedApiSecret: enc.apiSecret,
      isActive: true,
    });

    mock.method(http as any, "get", async (url: string) => {
      if (url.includes("/v5/market/time")) {
        return { data: { retCode: 0, result: { timeSecond: "1700000000" } } };
      }
      if (url.includes("/v5/account/wallet-balance")) {
        return {
          data: {
            retCode: 10002,
            retMsg: "wallet api timeout",
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    const result = await executeTrade(
      userId,
      {
        exchangeConnectionId: connection._id.toString(),
        balance: "500",
        pair: "BTCUSDT",
        entry: "50000",
        tp: "52000",
        sl: "49000",
        direction: "buy",
      },
      true,
    );

    assert.equal(result.status, 502);
    assert.equal(result.body.message, "Failed to verify available exchange balance.");
  });

  it("caps trade sizing balance by verified available funds while preserving subscription allocation", async () => {
    const proUserId = new mongoose.Types.ObjectId();
    const copierUserId = new mongoose.Types.ObjectId();

    const encPro = encryptCredentials("bybit", {
      apiKey: "pro-key",
      apiSecret: "pro-secret",
    });
    const encCopier = encryptCredentials("bybit", {
      apiKey: "copier-key",
      apiSecret: "copier-secret",
    });

    const proConnection = await ExchangeConnection.create({
      userId: proUserId,
      exchange: "bybit",
      encryptedApiKey: encPro.apiKey,
      encryptedApiSecret: encPro.apiSecret,
      isActive: true,
    });

    const copierConnection = await ExchangeConnection.create({
      userId: copierUserId,
      exchange: "bybit",
      encryptedApiKey: encCopier.apiKey,
      encryptedApiSecret: encCopier.apiSecret,
      isActive: true,
    });

    const signal = await Signal.create({
      pair: "BTCUSDT",
      entry: "50000",
      tp: "52000",
      sl: "49000",
      direction: "buy",
      trader: proUserId,
      status: "active",
    });

    const proTrade = await Trade.create({
      userId: proUserId,
      pair: "BTCUSDT",
      direction: "buy",
      tp: "52000",
      sl: "49000",
      entryPrice: "50000",
      quantity: "0.01",
      signalId: signal._id,
      tradeOrigin: "pro",
      exchangeConnectionId: proConnection._id,
      exchangeOrderId: "pro-order-1",
      status: "pending",
    });

    mock.method(http as any, "get", async (url: string) => {
      if (url.includes("/v5/market/time")) {
        return { data: { retCode: 0, result: { timeSecond: "1700000000" } } };
      }
      if (url.includes("/v5/account/wallet-balance")) {
        return {
          data: {
            retCode: 0,
            result: {
              list: [
                {
                  totalEquity: "1000.00",
                  totalAvailableBalance: "300.00",
                  coin: [
                    {
                      coin: "USDT",
                      walletBalance: "1000.00",
                      locked: "700.00",
                      availableToWithdraw: "300.00",
                    },
                  ],
                },
              ],
            },
          },
        };
      }
      if (url.includes("/v5/market/tickers")) {
        return {
          data: {
            retCode: 0,
            result: { list: [{ lastPrice: "50000" }] },
          },
        };
      }
      if (url.includes("/v5/market/instruments-info")) {
        return {
          data: {
            retCode: 0,
            result: {
              list: [
                {
                  symbol: "BTCUSDT",
                  priceFilter: { tickSize: "0.10" },
                  lotSizeFilter: {
                    qtyStep: "0.001",
                    minOrderQty: "0.001",
                    minNotionalValue: "5",
                  },
                },
              ],
            },
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    let capturedOrderPayload: any = null;
    mock.method(http as any, "post", async (_url: string, body: string) => {
      capturedOrderPayload = JSON.parse(body);
      return {
        data: {
          retCode: 0,
          result: { orderId: "bybit-copy-1" },
        },
      };
    });

    mock.method(
      TradeMonitorService.prototype,
      "startMonitoring",
      async () => {},
    );

    const result = await executeTrade(
      copierUserId,
      {
        sourceTradeId: proTrade._id.toString(),
        exchangeConnectionId: copierConnection._id.toString(),
        balance: "1000",
      },
      false,
    );

    assert.equal(result.status, 201);
    assert.equal(capturedOrderPayload.qty, "0.006");
  });

  it("prevents opening duplicate trade on an active pair on the same exchange connection", async () => {
    const userId = new mongoose.Types.ObjectId();
    const enc = encryptCredentials("bybit", {
      apiKey: "k",
      apiSecret: "s",
    });

    const connection = await ExchangeConnection.create({
      userId,
      exchange: "bybit",
      encryptedApiKey: enc.apiKey,
      encryptedApiSecret: enc.apiSecret,
      isActive: true,
    });

    const signal = await Signal.create({
      pair: "BTCUSDT",
      entry: "50000",
      tp: "52000",
      sl: "49000",
      direction: "buy",
      trader: userId,
      status: "active",
    });

    // Existing active trade on BTCUSDT
    await Trade.create({
      userId,
      pair: "BTCUSDT",
      direction: "buy",
      tp: "52000",
      sl: "49000",
      entryPrice: "50000",
      quantity: "0.01",
      signalId: signal._id,
      tradeOrigin: "pro",
      exchangeConnectionId: connection._id,
      exchangeOrderId: "existing-trade-1",
      status: "filled",
    });

    const result = await executeTrade(
      userId,
      {
        exchangeConnectionId: connection._id.toString(),
        balance: "500",
        pair: "BTCUSDT",
        entry: "50000",
        tp: "52000",
        sl: "49000",
        direction: "buy",
      },
      true,
    );

    assert.equal(result.status, 409);
    assert.match(
      result.body.message,
      /An active BTCUSDT trade already exists on this exchange connection/,
    );
  });

  it("returns ORDER_REVIEW_REQUIRED when exchange order succeeds but DB persistence fails", async () => {
    const userId = new mongoose.Types.ObjectId();
    const enc = encryptCredentials("bybit", {
      apiKey: "k",
      apiSecret: "s",
    });

    const connection = await ExchangeConnection.create({
      userId,
      exchange: "bybit",
      encryptedApiKey: enc.apiKey,
      encryptedApiSecret: enc.apiSecret,
      isActive: true,
    });

    mock.method(http as any, "get", async (url: string) => {
      if (url.includes("/v5/market/time")) {
        return { data: { retCode: 0, result: { timeSecond: "1700000000" } } };
      }
      if (url.includes("/v5/account/wallet-balance")) {
        return {
          data: {
            retCode: 0,
            result: {
              list: [
                {
                  totalEquity: "1000.00",
                  totalAvailableBalance: "1000.00",
                  coin: [{ coin: "USDT", walletBalance: "1000.00", locked: "0" }],
                },
              ],
            },
          },
        };
      }
      if (url.includes("/v5/market/tickers")) {
        return {
          data: {
            retCode: 0,
            result: { list: [{ lastPrice: "50000" }] },
          },
        };
      }
      if (url.includes("/v5/market/instruments-info")) {
        return {
          data: {
            retCode: 0,
            result: {
              list: [
                {
                  symbol: "BTCUSDT",
                  priceFilter: { tickSize: "0.10" },
                  lotSizeFilter: {
                    qtyStep: "0.001",
                    minOrderQty: "0.001",
                    minNotionalValue: "5",
                  },
                },
              ],
            },
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    mock.method(http as any, "post", async () => ({
      data: {
        retCode: 0,
        result: { orderId: "bybit-placed-order-999" },
      },
    }));

    // Simulate primary Trade.create throwing an error
    let firstCreate = true;
    const originalCreate = Trade.create.bind(Trade);
    mock.method(Trade, "create", async (...args: any[]) => {
      if (firstCreate) {
        firstCreate = false;
        throw new Error("Primary DB connection lost");
      }
      return originalCreate(...(args as [any]));
    });

    const result = await executeTrade(
      userId,
      {
        exchangeConnectionId: connection._id.toString(),
        balance: "500",
        pair: "BTCUSDT",
        entry: "50000",
        tp: "52000",
        sl: "49000",
        direction: "buy",
      },
      true,
    );

    assert.equal(result.status, 500);
    assert.equal(result.body.code, "ORDER_REVIEW_REQUIRED");
    assert.equal(result.body.exchangeOrderId, "bybit-placed-order-999");
  });
  it("rejects trade when 2% risk quantity is below exchange minimum quantity", async () => {
    const userId = new mongoose.Types.ObjectId();
    const enc = encryptCredentials("bybit", {
      apiKey: "k",
      apiSecret: "s",
    });

    const connection = await ExchangeConnection.create({
      userId,
      exchange: "bybit",
      encryptedApiKey: enc.apiKey,
      encryptedApiSecret: enc.apiSecret,
      isActive: true,
    });

    mock.method(http as any, "get", async (url: string) => {
      if (url.includes("/v5/market/time")) {
        return { data: { retCode: 0, result: { timeSecond: "1700000000" } } };
      }
      if (url.includes("/v5/account/wallet-balance")) {
        return {
          data: {
            retCode: 0,
            result: {
              list: [
                {
                  totalEquity: "100.00",
                  totalAvailableBalance: "100.00",
                  coin: [{ coin: "USDT", walletBalance: "100.00", locked: "0" }],
                },
              ],
            },
          },
        };
      }
      if (url.includes("/v5/market/tickers")) {
        return {
          data: {
            retCode: 0,
            result: { list: [{ lastPrice: "50000" }] },
          },
        };
      }
      if (url.includes("/v5/market/instruments-info")) {
        return {
          data: {
            retCode: 0,
            result: {
              list: [
                {
                  symbol: "BTCUSDT",
                  priceFilter: { tickSize: "0.10" },
                  lotSizeFilter: {
                    qtyStep: "0.001",
                    minOrderQty: "0.05", // High minOrderQty
                    minNotionalValue: "5",
                  },
                },
              ],
            },
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    // Balance = 100 USDT -> 2% risk = 2 USDT
    // Entry = 50000, SL = 49000 (distance = 1000)
    // Sizing = 2 / 1000 = 0.002 BTC, which is < minOrderQty 0.05
    const result = await executeTrade(
      userId,
      {
        exchangeConnectionId: connection._id.toString(),
        balance: "100",
        pair: "BTCUSDT",
        entry: "50000",
        tp: "52000",
        sl: "49000",
        direction: "buy",
      },
      true,
    );

    assert.equal(result.status, 422);
    assert.match(result.body.message, /below bybit minimum order quantity/);
  });

  it("distinguishes confirmed exchange rejection from ambiguous network timeout", async () => {
    const userId = new mongoose.Types.ObjectId();
    const enc = encryptCredentials("bybit", {
      apiKey: "k",
      apiSecret: "s",
    });

    const connection = await ExchangeConnection.create({
      userId,
      exchange: "bybit",
      encryptedApiKey: enc.apiKey,
      encryptedApiSecret: enc.apiSecret,
      isActive: true,
    });

    mock.method(http as any, "get", async (url: string) => {
      if (url.includes("/v5/market/time")) {
        return { data: { retCode: 0, result: { timeSecond: "1700000000" } } };
      }
      if (url.includes("/v5/account/wallet-balance")) {
        return {
          data: {
            retCode: 0,
            result: {
              list: [
                {
                  totalEquity: "1000.00",
                  totalAvailableBalance: "1000.00",
                  coin: [{ coin: "USDT", walletBalance: "1000.00", locked: "0" }],
                },
              ],
            },
          },
        };
      }
      if (url.includes("/v5/market/tickers")) {
        return {
          data: {
            retCode: 0,
            result: { list: [{ lastPrice: "50000" }] },
          },
        };
      }
      if (url.includes("/v5/market/instruments-info")) {
        return {
          data: {
            retCode: 0,
            result: {
              list: [
                {
                  symbol: "BTCUSDT",
                  priceFilter: { tickSize: "0.10" },
                  lotSizeFilter: {
                    qtyStep: "0.001",
                    minOrderQty: "0.001",
                    minNotionalValue: "5",
                  },
                },
              ],
            },
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    // 1. Confirmed exchange rejection (e.g. retCode 10001 params error)
    mock.method(http as any, "post", async () => ({
      data: {
        retCode: 10001,
        retMsg: "order quantity exceeds risk limit",
      },
    }));

    const rejectionResult = await executeTrade(
      userId,
      {
        exchangeConnectionId: connection._id.toString(),
        balance: "500",
        pair: "BTCUSDT",
        entry: "50000",
        tp: "52000",
        sl: "49000",
        direction: "buy",
      },
      true,
    );

    assert.equal(rejectionResult.status, 422);
    assert.equal(rejectionResult.body.code, "ORDER_REJECTED");
    assert.match(rejectionResult.body.message, /order quantity exceeds risk limit/);

    // 2. Ambiguous outcome (e.g. network timeout)
    mock.method(http as any, "post", async () => {
      const timeoutErr: any = new Error("timeout of 8000ms exceeded");
      timeoutErr.code = "ECONNABORTED";
      timeoutErr.isAxiosError = true;
      throw timeoutErr;
    });

    const timeoutResult = await executeTrade(
      userId,
      {
        exchangeConnectionId: connection._id.toString(),
        balance: "500",
        pair: "BTCUSDT",
        entry: "50000",
        tp: "52000",
        sl: "49000",
        direction: "buy",
      },
      true,
    );

    assert.equal(timeoutResult.status, 502);
    assert.equal(timeoutResult.body.code, "ORDER_REVIEW_REQUIRED");
    assert.equal(timeoutResult.body.exchange, "bybit");
    assert.ok(timeoutResult.body.clientOrderId);
  });

  it("safely handles signal.save() failure after exchange order acceptance", async () => {
    const userId = new mongoose.Types.ObjectId();
    const enc = encryptCredentials("bybit", {
      apiKey: "k",
      apiSecret: "s",
    });

    const connection = await ExchangeConnection.create({
      userId,
      exchange: "bybit",
      encryptedApiKey: enc.apiKey,
      encryptedApiSecret: enc.apiSecret,
      isActive: true,
    });

    mock.method(http as any, "get", async (url: string) => {
      if (url.includes("/v5/market/time")) {
        return { data: { retCode: 0, result: { timeSecond: "1700000000" } } };
      }
      if (url.includes("/v5/account/wallet-balance")) {
        return {
          data: {
            retCode: 0,
            result: {
              list: [
                {
                  totalEquity: "1000.00",
                  totalAvailableBalance: "1000.00",
                  coin: [{ coin: "USDT", walletBalance: "1000.00", locked: "0" }],
                },
              ],
            },
          },
        };
      }
      if (url.includes("/v5/market/tickers")) {
        return {
          data: {
            retCode: 0,
            result: { list: [{ lastPrice: "50000" }] },
          },
        };
      }
      if (url.includes("/v5/market/instruments-info")) {
        return {
          data: {
            retCode: 0,
            result: {
              list: [
                {
                  symbol: "BTCUSDT",
                  priceFilter: { tickSize: "0.10" },
                  lotSizeFilter: {
                    qtyStep: "0.001",
                    minOrderQty: "0.001",
                    minNotionalValue: "5",
                  },
                },
              ],
            },
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    mock.method(http as any, "post", async () => ({
      data: {
        retCode: 0,
        result: { orderId: "bybit-placed-order-12345" },
      },
    }));

    // Mock Signal.prototype.save to throw
    mock.method(Signal.prototype, "save", async () => {
      throw new Error("Signal validation or save failed");
    });

    const result = await executeTrade(
      userId,
      {
        exchangeConnectionId: connection._id.toString(),
        balance: "500",
        pair: "BTCUSDT",
        entry: "50000",
        tp: "52000",
        sl: "49000",
        direction: "buy",
      },
      true,
    );

    // Trade record is still created despite signal.save failure
    assert.equal(result.status, 201);
    assert.equal(result.body.trade.exchangeOrderId, "bybit-placed-order-12345");
  });

  it("marks Binance trade as review_required when TP/SL attachment fails", async () => {
    const monitorService = new TradeMonitorService();
    const tradeId = new mongoose.Types.ObjectId();

    await Trade.create({
      _id: tradeId,
      userId: new mongoose.Types.ObjectId(),
      pair: "BTCUSDT",
      direction: "buy",
      tp: "52000",
      sl: "49000",
      entryPrice: "50000",
      quantity: "0.01",
      exchangeOrderId: "binance-entry-order-1",
      exchangeConnectionId: new mongoose.Types.ObjectId(),
      signalId: new mongoose.Types.ObjectId(),
      tradeOrigin: "pro",
      status: "filled",
      monitoringStatus: "connecting",
    });

    const mockWsConn: any = {
      exchange: "binance",
      credentials: { apiKey: "key", apiSecret: "secret" },
      activeTrades: new Map(),
      ws: null,
    };

    const monitored: any = {
      tradeId: tradeId.toString(),
      exchangeOrderId: "binance-entry-order-1",
      pair: "BTCUSDT",
      direction: "buy",
      entryPrice: "50000",
      quantity: "0.01",
      tp: "52000",
      sl: "49000",
      protectionSetupStarted: false,
    };

    // Mock attachBinanceTpSl failure by having http.post throw
    mock.method(http as any, "get", async (url: string) => {
      if (url.includes("/fapi/v1/time")) {
        return { data: { serverTime: 1700000000000 } };
      }
      if (url.includes("/fapi/v1/openOrders") || url.includes("/fapi/v1/allOrders")) {
        return { data: [] };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    mock.method(http as any, "post", async () => {
      throw new Error("Binance margin error during TP/SL attachment");
    });

    // Call private ensureBinanceProtection
    await (monitorService as any).ensureBinanceProtection(mockWsConn, monitored, true);

    const updatedTrade = await Trade.findById(tradeId).lean();
    assert.equal(updatedTrade?.monitoringStatus, "review_required");
    assert.match(updatedTrade?.monitoringError || "", /TP\/SL protection attachment failed/);
  });
  it("retains automatic-copy execution lock when trade outcome is ambiguous to prevent duplicate retries", async () => {
    const proId = new mongoose.Types.ObjectId();
    const copierId = new mongoose.Types.ObjectId();
    const connectionId = new mongoose.Types.ObjectId();
    const sourceTradeId = new mongoose.Types.ObjectId();

    await User.create([
      {
        _id: proId,
        email: "pro@test.com",
        firstName: "Pro",
        lastName: "Trader",
        traderID: "PRO12345",
        password: "password123",
        role: "ProTrader",
        status: "active",
      },
      {
        _id: copierId,
        email: "copier@test.com",
        firstName: "Copy",
        lastName: "Trader",
        traderID: "CPY12345",
        password: "password123",
        role: "CopyTrader",
        status: "active",
      },
    ]);

    const sourceTrade = await Trade.create({
      _id: sourceTradeId,
      userId: proId,
      pair: "BTCUSDT",
      direction: "buy",
      tp: "52000",
      sl: "49000",
      entryPrice: "50000",
      quantity: "0.01",
      tradeOrigin: "pro",
      exchangeOrderId: "pro-order-1",
      exchangeConnectionId: connectionId,
      signalId: new mongoose.Types.ObjectId(),
      status: "filled",
    });

    const subscription = await CopySubscription.create({
      proTraderId: proId,
      copierId,
      exchangeConnectionId: connectionId,
      allocation: 200,
      active: true,
      startedAt: new Date(Date.now() - 10000),
    });

    const execution = await CopyExecution.create({
      sourceTradeId,
      subscriptionId: subscription._id,
      copierId,
      exchangeConnectionId: connectionId,
      status: "queued",
      availableAt: new Date(Date.now() - 1000),
    });

    // Mock executeTrade to return ORDER_REVIEW_REQUIRED (ambiguous outcome)
    const mockExecuteTrade = async () => ({
      status: 502,
      body: {
        code: "ORDER_REVIEW_REQUIRED",
        message: "Order outcome ambiguous; review required",
      },
    });

    const mockRefreshBalance = async () => 500;

    await drainCopyQueue({
      executeTrade: mockExecuteTrade as any,
      refreshConnectionBalance: mockRefreshBalance as any,
    });

    // Lock must be RETAINED to prevent duplicate automatic submissions
    const lock = await CopyExecutionLock.findOne({ connectionId });
    assert.ok(lock, "CopyExecutionLock must be retained on ambiguous outcome");
    assert.equal(String(lock?.executionId), String(execution._id));

    // And execution job is marked failed
    const updatedJob = await CopyExecution.findById(execution._id).lean();
    assert.equal(updatedJob?.status, "failed");
  });
});
