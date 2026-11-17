import test from "node:test";
import assert from "node:assert/strict";
import { getExchangeMode, getExchangeRestUrl, getExchangeWebSocketUrl, isBitgetDemo, isOkxDemo } from "../src/services/exchangeEnvironment.js";
import { tronHost, reconciliationClient } from "../src/services/proFinanceService.js";
import { signAccessToken, signRefreshToken, verifyToken } from "../src/helpers/jwtHelper.js";

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("one exchange mode selects matching REST, WebSocket, and simulated-header environments", () => {
  for (const mode of ["testnet", "live"] as const) {
    withEnv({ EXCHANGE_MODE: mode, BINANCE_API_URL: undefined, BINANCE_FUTURES_TEST_API_URL: undefined, BYBIT_WS_URL: undefined, BYBIT_TEST_WS_URL: undefined }, () => {
      assert.equal(isBitgetDemo(), mode === "testnet");
      assert.equal(isOkxDemo(), mode === "testnet");
      assert.equal(getExchangeRestUrl("binance"), mode === "testnet" ? "https://testnet.binancefuture.com" : "https://fapi.binance.com");
      assert.equal(getExchangeWebSocketUrl("bybit"), mode === "testnet" ? "wss://stream-testnet.bybit.com/v5/private" : "wss://stream.bybit.com/v5/private");
    });
  }
});

test("the Bitget REST override is normalized and shared by every trading environment", () => {
  for (const mode of ["testnet", "live"]) {
    withEnv({ EXCHANGE_MODE: mode, BITGET_API_URL: "https://bitget.example/" }, () => {
      assert.equal(getExchangeRestUrl("bitget"), "https://bitget.example");
    });
  }
});

test("exchange defaults use production live accounts and development test accounts consistently", () => {
  for (const environment of ["production", "development"]) {
    withEnv({ EXCHANGE_MODE: undefined, NODE_ENV: environment }, () => {
      assert.equal(getExchangeMode(), environment === "production" ? "live" : "testnet");
      assert.equal(isOkxDemo(), environment !== "production");
      assert.equal(isBitgetDemo(), environment !== "production");
    });
  }
});

test("shared TRON provider keeps read-only reconciliation on the supported mainnet endpoint", () => {
  withEnv({ TRON_FULL_HOST: "https://api.trongrid.io/" }, () => {
    assert.equal(tronHost(), "https://api.trongrid.io");
    assert.equal(reconciliationClient().fullNode.host, "https://api.trongrid.io");
  });
  for (const host of ["https://api.shasta.trongrid.io", "http://api.trongrid.io"]) {
    withEnv({ TRON_FULL_HOST: host }, () => assert.throws(tronHost, /mainnet/));
  }
});

test("one JWT secret still separates access, refresh, user, and admin tokens", () => {
  withEnv({ JWT_SECRET: "test-only-signing-key-with-at-least-32-characters", JWT_EXPIRES_IN: "15m", JWT_REFRESH_EXPIRES_IN: "7d" }, () => {
    const access = signAccessToken("test-user", "user", 3);
    const refresh = signRefreshToken("test-user", "user", 3);
    assert.equal(verifyToken(access, "user").sv, 3);
    assert.equal(verifyToken(refresh, "user", true).sub, "test-user");
    assert.throws(() => verifyToken(access, "user", true));
    assert.throws(() => verifyToken(refresh, "user"));
    assert.throws(() => verifyToken(access, "admin"));
  });
});
