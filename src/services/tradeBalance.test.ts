import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { http } from "./exchangeConnectionService.js";
import {
  getExchangeBalance,
  getExchangeAvailableBalance,
} from "./tradeService.js";
import type { RawCredentials } from "../types/index.js";

const credentials: RawCredentials = {
  apiKey: "test-api-key",
  apiSecret: "test-api-secret",
  passphrase: "test-passphrase",
};

describe("Exchange Balance Handling", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe("Binance Futures balance parsing", () => {
    it("distinguishes availableBalance from walletBalance", async () => {
      mock.method(http as any, "get", async (url: string) => {
        if (url.includes("/fapi/v1/time")) {
          return { data: { serverTime: 1700000000000 } };
        }
        if (url.includes("/fapi/v2/account")) {
          return {
            data: {
              totalWalletBalance: "1500.00",
              totalMarginBalance: "1450.00",
              availableBalance: "350.50",
              assets: [
                {
                  asset: "USDT",
                  walletBalance: "1500.00",
                  marginBalance: "1149.50",
                  availableBalance: "350.50",
                },
                {
                  asset: "BNB",
                  walletBalance: "2.5",
                  marginBalance: "0",
                  availableBalance: "2.5",
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected GET ${url}`);
      });

      const res = await getExchangeBalance("binance", credentials);

      assert.equal(res.totalUsdtEquivalent, "1500.00");
      assert.equal(res.availableUsdt, "350.50");
      assert.equal(res.balances.length, 2);
      assert.equal(res.balances[0]!.asset, "USDT");
      assert.equal(res.balances[0]!.free, "350.50");

      const available = await getExchangeAvailableBalance("binance", credentials);
      assert.equal(available, 350.5);
    });
  });

  describe("Bybit UTA balance parsing", () => {
    it("reads totalAvailableBalance for futures risk sizing while preserving totalEquity", async () => {
      mock.method(http as any, "get", async (url: string) => {
        if (url.includes("/v5/market/time")) {
          return {
            data: { retCode: 0, result: { timeSecond: "1700000000" } },
          };
        }
        if (url.includes("/v5/account/wallet-balance")) {
          return {
            data: {
              retCode: 0,
              retMsg: "OK",
              result: {
                list: [
                  {
                    totalEquity: "5000.00",
                    totalWalletBalance: "4800.00",
                    totalMarginBalance: "4200.00",
                    totalAvailableBalance: "1250.75",
                    coin: [
                      {
                        coin: "USDT",
                        walletBalance: "4000.00",
                        locked: "500.00",
                        availableToWithdraw: "1250.75",
                      },
                      {
                        coin: "BTC",
                        walletBalance: "0.05",
                        locked: "0",
                        availableToWithdraw: "0.05",
                      },
                    ],
                  },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected GET ${url}`);
      });

      const res = await getExchangeBalance("bybit", credentials);

      assert.equal(res.totalUsdtEquivalent, "5000.00");
      assert.equal(res.availableUsdt, "1250.75");
      assert.equal(res.balances.length, 2);

      const available = await getExchangeAvailableBalance("bybit", credentials);
      assert.equal(available, 1250.75);
    });
  });

  describe("Bitget Futures balance parsing", () => {
    it("reads mix available margin while preserving totalUsdtEquivalent", async () => {
      mock.method(http as any, "get", async (url: string) => {
        if (url.includes("/api/v2/mix/account/accounts")) {
          return {
            data: {
              code: "00000",
              msg: "success",
              data: [
                {
                  marginCoin: "USDT",
                  locked: "800.00",
                  available: "450.25",
                  maxOpenPosAvailable: "450.25",
                  usdtEquity: "1250.25",
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected GET ${url}`);
      });

      const res = await getExchangeBalance("bitget", credentials);

      assert.equal(res.totalUsdtEquivalent, "1250.25");
      assert.equal(res.availableUsdt, "450.25");
      assert.equal(res.balances[0]!.asset, "USDT");
      assert.equal(res.balances[0]!.free, "450.25");

      const available = await getExchangeAvailableBalance("bitget", credentials);
      assert.equal(available, 450.25);
    });
  });

  describe("Safe rejection of missing or unavailable balances", () => {
    it("fails safely when exchange returns non-finite available funds", async () => {
      mock.method(http as any, "get", async () => ({
        data: {
          code: "00000",
          msg: "success",
          data: [],
        },
      }));

      await assert.rejects(
        () => getExchangeAvailableBalance("bitget", credentials),
        /Available USDT balance could not be verified for bitget/,
      );
    });

    it("fails safely when exchange returns API error", async () => {
      mock.method(http as any, "get", async () => ({
        data: {
          retCode: 10003,
          retMsg: "API key is invalid",
        },
      }));

      await assert.rejects(
        () => getExchangeAvailableBalance("bybit", credentials),
        /Bybit error: API key is invalid/,
      );
    });
  });
});
