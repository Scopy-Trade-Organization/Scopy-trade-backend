import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getExchangeMode,
  isTestnet,
  isBitgetDemo,
  getExchangeRestUrl,
  getExchangeWebSocketUrl,
} from "./exchangeEnvironment.js";

describe("exchangeEnvironment", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("getExchangeMode & isTestnet", () => {
    it("defaults to testnet when EXCHANGE_MODE is unset", () => {
      delete process.env.EXCHANGE_MODE;
      process.env.NODE_ENV = "production";
      assert.equal(getExchangeMode(), "testnet");
      assert.equal(isTestnet(), true);
    });

    it("defaults to testnet when EXCHANGE_MODE is empty or unrecognized", () => {
      process.env.EXCHANGE_MODE = "unknown";
      assert.equal(getExchangeMode(), "testnet");
      assert.equal(isTestnet(), true);
    });

    it("enables live mode only when EXCHANGE_MODE is explicitly 'live'", () => {
      process.env.EXCHANGE_MODE = "live";
      assert.equal(getExchangeMode(), "live");
      assert.equal(isTestnet(), false);

      process.env.EXCHANGE_MODE = "LIVE ";
      assert.equal(getExchangeMode(), "live");
      assert.equal(isTestnet(), false);
    });
  });

  describe("Bitget demo mode resolution", () => {
    it("defaults to demo when EXCHANGE_MODE is testnet and BITGET_DEMO_MODE is unset", () => {
      delete process.env.EXCHANGE_MODE;
      delete process.env.BITGET_DEMO_MODE;
      assert.equal(isBitgetDemo(), true);
    });

    it("switches to live when EXCHANGE_MODE is live and BITGET_DEMO_MODE is unset", () => {
      process.env.EXCHANGE_MODE = "live";
      delete process.env.BITGET_DEMO_MODE;
      assert.equal(isBitgetDemo(), false);
    });

    it("respects explicit BITGET_DEMO_MODE='true' even when EXCHANGE_MODE is live", () => {
      process.env.EXCHANGE_MODE = "live";
      process.env.BITGET_DEMO_MODE = "true";
      assert.equal(isBitgetDemo(), true);
    });

    it("respects explicit BITGET_DEMO_MODE='false' even when EXCHANGE_MODE is testnet", () => {
      process.env.EXCHANGE_MODE = "testnet";
      process.env.BITGET_DEMO_MODE = "false";
      assert.equal(isBitgetDemo(), false);
    });
  });

  describe("Exchange REST and WebSocket URLs", () => {
    it("returns correct Bybit URLs for testnet and live", () => {
      process.env.EXCHANGE_MODE = "testnet";
      assert.equal(getExchangeRestUrl("bybit"), "https://api-testnet.bybit.com");
      assert.equal(
        getExchangeWebSocketUrl("bybit"),
        "wss://stream-testnet.bybit.com/v5/private",
      );

      process.env.EXCHANGE_MODE = "live";
      assert.equal(getExchangeRestUrl("bybit"), "https://api.bybit.com");
      assert.equal(
        getExchangeWebSocketUrl("bybit"),
        "wss://stream.bybit.com/v5/private",
      );
    });

    it("returns correct Bitget REST and WebSocket URLs", () => {
      delete process.env.BITGET_API_URL;
      delete process.env.BITGET_BASE_URL;
      delete process.env.BITGET_WS_URL;

      assert.equal(getExchangeRestUrl("bitget"), "https://api.bitget.com");
      assert.equal(
        getExchangeWebSocketUrl("bitget"),
        "wss://ws.bitget.com/v2/ws/private",
      );

      process.env.BITGET_API_URL = "https://custom-bitget.example.com/";
      assert.equal(
        getExchangeRestUrl("bitget"),
        "https://custom-bitget.example.com",
      );

      process.env.BITGET_WS_URL = "wss://custom-ws.bitget.com/ws";
      assert.equal(
        getExchangeWebSocketUrl("bitget"),
        "wss://custom-ws.bitget.com/ws",
      );
    });
  });
});