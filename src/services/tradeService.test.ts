import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { http } from "./exchangeConnectionService.js";
import {
  getOrderStatus,
  placeOrder,
  clearContractRulesCache,
  classifyOrderError,
  reconcileOrderByClientOrderId,
} from "./tradeService.js";
import type { RawCredentials } from "../types/index.js";

const credentials: RawCredentials = {
  apiKey: "test-api-key",
  apiSecret: "test-api-secret",
  passphrase: "test-passphrase",
};

const params = {
  credentials,
  pair: "BTCUSDT",
  direction: "buy" as const,
  clientOrderId: "sc_test_order",
  quantity: "0.012345",
  entryPrice: "50123.46",
  tp: "51123.46",
  sl: "49123.44",
};

function mockBitgetContract(): void {
  mock.method(http as any, "get", async (url: string) => {
    if (url.includes("/api/v2/mix/market/contracts")) {
      return {
        data: {
          code: "00000",
          msg: "success",
          data: [
            {
              symbol: "BTCUSDT",
              minTradeNum: "0.001",
              minTradeUSDT: "5",
              priceEndStep: "1",
              pricePlace: "1",
              sizeMultiplier: "0.001",
              symbolStatus: "normal",
            },
          ],
        },
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  });
}

function mockBybitContract(): void {
  mock.method(http as any, "get", async (url: string) => {
    if (url.includes("/v5/market/time")) {
      return {
        data: {
          retCode: 0,
          result: { timeSecond: "1700000000" },
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
}

describe("Bitget and Bybit Order Execution & Live/Demo Mode", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    mock.restoreAll();
    process.env = { ...originalEnv };
    clearContractRulesCache();
  });

  describe("Bitget Order Placement", () => {
    it("places Bitget order in demo mode with paptrading header", async () => {
      process.env.BITGET_DEMO_MODE = "true";
      mockBitgetContract();

      let capturedBody = "";
      let capturedHeaders: Record<string, string> = {};
      let capturedUrl = "";

      mock.method(http as any, "post", async (url: string, body: string, config: any) => {
        capturedUrl = url;
        capturedBody = body;
        capturedHeaders = config.headers;
        return { data: { code: "00000", msg: "success", data: { orderId: "bg-123" } } };
      });

      const result = await placeOrder("bitget", params);
      const body = JSON.parse(capturedBody);

      assert.equal(result.orderId, "bg-123");
      assert.equal(capturedUrl, "https://api.bitget.com/api/v2/mix/order/place-order");
      assert.equal(body.size, "0.012");
      assert.equal(body.price, "50123.5");
      assert.equal(body.presetStopSurplusPrice, "51123.5");
      assert.equal(body.presetStopLossPrice, "49123.4");
      assert.equal(body.productType, "USDT-FUTURES");
      assert.equal(body.marginCoin, "USDT");
      assert.equal(capturedHeaders.paptrading, "1");
      assert.equal(capturedHeaders["ACCESS-KEY"], "test-api-key");
      assert.equal(capturedHeaders["ACCESS-PASSPHRASE"], "test-passphrase");
    });

    it("places Bitget order in live mode without paptrading header when EXCHANGE_MODE is live", async () => {
      process.env.EXCHANGE_MODE = "live";
      delete process.env.BITGET_DEMO_MODE;
      mockBitgetContract();

      let capturedHeaders: Record<string, string> = {};

      mock.method(http as any, "post", async (_url: string, _body: string, config: any) => {
        capturedHeaders = config.headers;
        return { data: { code: "00000", msg: "success", data: { orderId: "bg-live-1" } } };
      });

      const result = await placeOrder("bitget", params);
      assert.equal(result.orderId, "bg-live-1");
      assert.equal(capturedHeaders.paptrading, undefined);
    });

    it("rejects Bitget orders below contract minimums", async () => {
      mockBitgetContract();

      await assert.rejects(
        () => placeOrder("bitget", { ...params, quantity: "0.0009" }),
        /below Bitget Futures minimum/,
      );
    });

    it("reads Bitget order status correctly", async () => {
      mock.method(http as any, "get", async () => ({
        data: {
          code: "00000",
          msg: "success",
          data: { state: "filled", priceAvg: "50123.5" },
        },
      }));

      const result = await getOrderStatus("bitget", credentials, "BTCUSDT", "bg-123");
      assert.equal(result.status, "filled");
      assert.equal(result.filledPrice, "50123.5");
    });
  });

  describe("Bybit Order Placement", () => {
    it("routes to Bybit testnet when in testnet mode", async () => {
      process.env.EXCHANGE_MODE = "testnet";
      mockBybitContract();

      let capturedUrl = "";
      let capturedBody = "";
      let capturedHeaders: Record<string, string> = {};

      mock.method(http as any, "post", async (url: string, body: string, config: any) => {
        capturedUrl = url;
        capturedBody = body;
        capturedHeaders = config.headers;
        return {
          data: {
            retCode: 0,
            retMsg: "OK",
            result: { orderId: "bybit-order-1" },
          },
        };
      });

      const result = await placeOrder("bybit", params);
      assert.equal(result.orderId, "bybit-order-1");
      assert.ok(capturedUrl.startsWith("https://api-testnet.bybit.com/v5/order/create"));

      const body = JSON.parse(capturedBody);
      assert.equal(body.category, "linear");
      assert.equal(body.symbol, "BTCUSDT");
      assert.equal(body.takeProfit, "51123.5");
      assert.equal(body.stopLoss, "49123.4");
      assert.equal(body.tpslMode, "Full");
      assert.equal(capturedHeaders["X-BAPI-API-KEY"], "test-api-key");
      assert.ok(capturedHeaders["X-BAPI-SIGN"]);
    });

    it("routes to Bybit production URL when EXCHANGE_MODE is live", async () => {
      process.env.EXCHANGE_MODE = "live";
      mockBybitContract();

      let capturedUrl = "";

      mock.method(http as any, "post", async (url: string) => {
        capturedUrl = url;
        return {
          data: {
            retCode: 0,
            retMsg: "OK",
            result: { orderId: "bybit-live-1" },
          },
        };
      });

      const result = await placeOrder("bybit", params);
      assert.equal(result.orderId, "bybit-live-1");
      assert.ok(capturedUrl.startsWith("https://api.bybit.com/v5/order/create"));
    });

    it("reads Bybit order status correctly", async () => {
      mock.method(http as any, "get", async (url: string) => {
        if (url.includes("/v5/market/time")) {
          return { data: { retCode: 0, result: { timeSecond: "1700000000" } } };
        }
        return {
          data: {
            retCode: 0,
            result: {
              list: [{ orderStatus: "Filled", avgPrice: "50123.50" }],
            },
          },
        };
      });

      const result = await getOrderStatus("bybit", credentials, "BTCUSDT", "bybit-123");
      assert.equal(result.status, "filled");
      assert.equal(result.filledPrice, "50123.50");
    });
  });

  describe("Exchange Error Sanitization", () => {
    it("formats Bitget error cleanly without exposing secrets", async () => {
      mockBitgetContract();
      mock.method(http as any, "post", async () => {
        throw {
          isAxiosError: true,
          response: {
            status: 400,
            data: { code: "40017", msg: "insufficient margin" },
          },
        };
      });

      await assert.rejects(
        () => placeOrder("bitget", params),
        /Bitget order rejected \(40017\): insufficient margin/,
      );
    });

    it("formats Bybit error cleanly without exposing secrets", async () => {
      mockBybitContract();
      mock.method(http as any, "post", async () => ({
        data: {
          retCode: 10001,
          retMsg: "params error: qty invalid",
        },
      }));

      await assert.rejects(
        () => placeOrder("bybit", params),
        /params error: qty invalid/,
      );
    });
  });
  describe("Order Error Classification", () => {
    it("classifies explicit exchange 400 rejection as EXCHANGE_REJECTED", async () => {
      mockBitgetContract();
      mock.method(http as any, "post", async () => {
        throw {
          isAxiosError: true,
          response: {
            status: 400,
            data: { code: "40017", msg: "insufficient margin" },
          },
        };
      });

      try {
        await placeOrder("bitget", params);
        assert.fail("Should have thrown");
      } catch (err: any) {
        assert.equal(err.name, "OrderExecutionError");
        assert.equal(err.classification, "EXCHANGE_REJECTED");
        assert.equal(err.exchange, "bitget");
        assert.equal(err.status, 400);
        assert.equal(err.exchangeCode, "40017");
        assert.equal(err.clientOrderId, "sc_test_order");
        assert.equal(err.originalMessage, "insufficient margin");
      }
    });

    it("classifies network timeout as AMBIGUOUS_OUTCOME", async () => {
      mockBitgetContract();
      mock.method(http as any, "post", async () => {
        const timeoutErr: any = new Error("timeout of 8000ms exceeded");
        timeoutErr.isAxiosError = true;
        timeoutErr.code = "ECONNABORTED";
        throw timeoutErr;
      });

      try {
        await placeOrder("bitget", params);
        assert.fail("Should have thrown");
      } catch (err: any) {
        assert.equal(err.name, "OrderExecutionError");
        assert.equal(err.classification, "AMBIGUOUS_OUTCOME");
        assert.equal(err.exchange, "bitget");
        assert.equal(err.clientOrderId, "sc_test_order");
      }
    });

    it("classifies HTTP 408 Request Timeout as AMBIGUOUS_OUTCOME (never confirmed rejection)", () => {
      const err: any = {
        isAxiosError: true,
        message: "Request failed with status code 408",
        response: {
          status: 408,
          data: { code: "408", msg: "Request Timeout" },
        },
      };

      const classified = classifyOrderError("binance", err, "cl_test_408");
      assert.equal(classified.name, "OrderExecutionError");
      assert.equal(classified.classification, "AMBIGUOUS_OUTCOME", "HTTP 408 must be treated as AMBIGUOUS_OUTCOME");
      assert.equal(classified.status, 408);
      assert.equal(classified.clientOrderId, "cl_test_408");
    });

    it("classifies HTTP 400 Bad Request as EXCHANGE_REJECTED", () => {
      const err: any = {
        isAxiosError: true,
        message: "Request failed with status code 400",
        response: {
          status: 400,
          data: { code: -1111, msg: "Precision is over the maximum defined for this asset." },
        },
      };

      const classified = classifyOrderError("binance", err, "cl_test_400");
      assert.equal(classified.name, "OrderExecutionError");
      assert.equal(classified.classification, "EXCHANGE_REJECTED", "HTTP 400 must be treated as EXCHANGE_REJECTED");
      assert.equal(classified.status, 400);
      assert.equal(classified.exchangeCode, "-1111");
    });
  });
  describe("Axios Retry Policy & Duplicate Order Prevention", () => {
    it("never retries order submission POST on network timeout (exactly 1 POST attempted)", async () => {
      mockBitgetContract();

      let postCount = 0;
      mock.method(http as any, "post", async () => {
        postCount++;
        const timeoutErr: any = new Error("timeout of 8000ms exceeded");
        timeoutErr.isAxiosError = true;
        timeoutErr.code = "ECONNABORTED";
        throw timeoutErr;
      });

      // Mock reconciliation GET to return UNRESOLVED
      mock.method(http as any, "get", async (url: string) => {
        if (url.includes("/api/v2/mix/market/contracts")) {
          return {
            data: {
              code: "00000",
              msg: "success",
              data: [
                {
                  symbol: "BTCUSDT",
                  minTradeNum: "0.001",
                  minTradeUSDT: "5",
                  priceEndStep: "1",
                  pricePlace: "1",
                  sizeMultiplier: "0.001",
                  symbolStatus: "normal",
                },
              ],
            },
          };
        }
        if (url.includes("/api/v2/mix/order/detail")) {
          throw new Error("Reconciliation network timeout");
        }
        throw new Error(`Unexpected GET ${url}`);
      });

      try {
        await placeOrder("bitget", params);
        assert.fail("Should have thrown");
      } catch (err: any) {
        assert.equal(err.name, "OrderExecutionError");
        assert.equal(err.classification, "AMBIGUOUS_OUTCOME");
      }

      // Exactly 1 POST must have been attempted - NO automatic retry of order submission
      assert.equal(postCount, 1, "Order POST must NOT be automatically retried");
    });

    it("never retries order submission POST on exchange 5xx error (exactly 1 POST attempted)", async () => {
      mockBybitContract();

      let postCount = 0;
      mock.method(http as any, "post", async () => {
        postCount++;
        throw {
          isAxiosError: true,
          response: {
            status: 502,
            data: "Bad Gateway",
          },
        };
      });

      try {
        await placeOrder("bybit", params);
        assert.fail("Should have thrown");
      } catch (err: any) {
        assert.equal(err.name, "OrderExecutionError");
        assert.equal(err.classification, "AMBIGUOUS_OUTCOME");
      }

      assert.equal(postCount, 1, "Order POST must NOT be automatically retried on 5xx");
    });

    it("reconciles order via client order ID when network timeout occurs and order is confirmed on exchange", async () => {
      mockBitgetContract();

      let postCount = 0;
      mock.method(http as any, "post", async () => {
        postCount++;
        const timeoutErr: any = new Error("timeout of 8000ms exceeded");
        timeoutErr.isAxiosError = true;
        timeoutErr.code = "ECONNABORTED";
        throw timeoutErr;
      });

      // Mock reconciliation GET query by clientOid finding the order
      mock.method(http as any, "get", async (url: string) => {
        if (url.includes("/api/v2/mix/market/contracts")) {
          return {
            data: {
              code: "00000",
              msg: "success",
              data: [
                {
                  symbol: "BTCUSDT",
                  minTradeNum: "0.001",
                  minTradeUSDT: "5",
                  priceEndStep: "1",
                  pricePlace: "1",
                  sizeMultiplier: "0.001",
                  symbolStatus: "normal",
                },
              ],
            },
          };
        }
        if (url.includes("/api/v2/mix/order/detail") && url.includes("clientOid=sc_test_order")) {
          return {
            data: {
              code: "00000",
              msg: "success",
              data: {
                orderId: "bg-reconciled-999",
                clientOid: "sc_test_order",
                state: "live",
                priceAvg: "50123.5",
              },
            },
          };
        }
        throw new Error(`Unexpected GET ${url}`);
      });

      // placeOrder should catch the timeout, query via clientOid, find the order, and succeed!
      const result = await placeOrder("bitget", params);
      assert.equal(result.orderId, "bg-reconciled-999");
      assert.equal(postCount, 1, "Must NOT have submitted a second POST");
    });

    it("preserves exchange-specific client order IDs across Binance, Bybit, and Bitget", async () => {
      // 1. Bitget clientOid
      mockBitgetContract();
      let bitgetBody: any;
      mock.method(http as any, "post", async (_url: string, body: string) => {
        bitgetBody = JSON.parse(body);
        return { data: { code: "00000", data: { orderId: "bg-1" } } };
      });
      await placeOrder("bitget", { ...params, clientOrderId: "bg_client_oid_123" });
      assert.equal(bitgetBody.clientOid, "bg_client_oid_123");

      // 2. Bybit orderLinkId
      mockBybitContract();
      let bybitBody: any;
      mock.method(http as any, "post", async (_url: string, body: string) => {
        bybitBody = JSON.parse(body);
        return { data: { retCode: 0, result: { orderId: "bb-1" } } };
      });
      await placeOrder("bybit", { ...params, clientOrderId: "bb_order_link_123" });
      assert.equal(bybitBody.orderLinkId, "bb_order_link_123");

      // 3. Binance newClientOrderId
      mock.method(http as any, "get", async (url: string) => {
        if (url.includes("/fapi/v1/exchangeInfo")) {
          return {
            data: {
              symbols: [
                {
                  symbol: "BTCUSDT",
                  status: "TRADING",
                  filters: [
                    { filterType: "PRICE_FILTER", tickSize: "0.10" },
                    { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
                    { filterType: "MIN_NOTIONAL", notional: "5" },
                  ],
                },
              ],
            },
          };
        }
        if (url.includes("/fapi/v1/time")) {
          return { data: { serverTime: 1700000000000 } };
        }
        throw new Error(`Unexpected GET ${url}`);
      });

      let binanceConfig: any;
      mock.method(http as any, "post", async (_url: string, _body: any, config: any) => {
        binanceConfig = config;
        return { data: { orderId: "bn-1" } };
      });

      await placeOrder("binance", { ...params, clientOrderId: "bn_client_id_123" });
      assert.equal(binanceConfig.params.newClientOrderId, "bn_client_id_123");

      // 4. OKX clOrdId
      let okxBody: any;
      mock.method(http as any, "post", async (_url: string, body: string) => {
        okxBody = JSON.parse(body);
        return { data: { code: "0", data: [{ ordId: "okx-1", sCode: "0" }] } };
      });
      await placeOrder("okx", { ...params, pair: "BTC-USDT-SWAP", clientOrderId: "okx_client_id_123" });
      assert.equal(okxBody.clOrdId, "okx_client_id_123");
    });
  });

  describe("Reconciliation Environment Consistency", () => {
    it("OKX reconciliation uses dynamic live environment when live mode is active", async () => {
      process.env.EXCHANGE_MODE = "live";
      process.env.OKX_DEMO_MODE = "false";

      let requestUrl: string = "";
      let requestHeaders: any = {};
      mock.method(http as any, "get", async (url: string, config: any) => {
        requestUrl = url;
        requestHeaders = config?.headers || {};
        return {
          data: {
            code: "0",
            data: [{ ordId: "okx-recon-live-1", clOrdId: "sc_cl_okx_live" }],
          },
        };
      });

      const res = await reconcileOrderByClientOrderId("okx", credentials, "BTC-USDT-SWAP", "sc_cl_okx_live", 0);
      assert.notEqual(res, "NOT_FOUND");
      assert.notEqual(res, "UNRESOLVED");
      if (typeof res === "object") {
        assert.equal(res.orderId, "okx-recon-live-1");
      }
      assert.match(requestUrl, /api\/v5\/trade\/order/);
      assert.equal(requestHeaders["x-simulated-trading"], undefined, "Live OKX reconciliation must not include x-simulated-trading header");
    });

    it("OKX reconciliation passes x-simulated-trading header when demo mode is active", async () => {
      process.env.EXCHANGE_MODE = "live";
      process.env.OKX_DEMO_MODE = "true";

      let requestHeaders: any = {};
      mock.method(http as any, "get", async (_url: string, config: any) => {
        requestHeaders = config?.headers || {};
        return {
          data: {
            code: "0",
            data: [{ ordId: "okx-recon-demo-1", clOrdId: "sc_cl_okx_demo" }],
          },
        };
      });

      const res = await reconcileOrderByClientOrderId("okx", credentials, "BTC-USDT-SWAP", "sc_cl_okx_demo", 0);
      assert.notEqual(res, "NOT_FOUND");
      assert.notEqual(res, "UNRESOLVED");
      assert.equal(requestHeaders["x-simulated-trading"], "1", "Demo OKX reconciliation must include x-simulated-trading header");
    });

    it("Bitget reconciliation omits paptrading header in live mode and includes it in demo mode", async () => {
      // Live mode
      process.env.EXCHANGE_MODE = "live";
      process.env.BITGET_DEMO_MODE = "false";

      let liveHeaders: any = {};
      mock.method(http as any, "get", async (_url: string, config: any) => {
        liveHeaders = config?.headers || {};
        return {
          data: {
            code: "00000",
            data: { orderId: "bg-recon-live-1", clientOid: "sc_cl_bg_live" },
          },
        };
      });

      await reconcileOrderByClientOrderId("bitget", credentials, "BTCUSDT", "sc_cl_bg_live", 0);
      assert.equal(liveHeaders.paptrading, undefined, "Live Bitget reconciliation must omit paptrading header");

      // Demo mode
      process.env.BITGET_DEMO_MODE = "true";
      let demoHeaders: any = {};
      mock.method(http as any, "get", async (_url: string, config: any) => {
        demoHeaders = config?.headers || {};
        return {
          data: {
            code: "00000",
            data: { orderId: "bg-recon-demo-1", clientOid: "sc_cl_bg_demo" },
          },
        };
      });

      await reconcileOrderByClientOrderId("bitget", credentials, "BTCUSDT", "sc_cl_bg_demo", 0);
      assert.equal(demoHeaders.paptrading, "1", "Demo Bitget reconciliation must include paptrading header");
    });
  });

  describe("Delayed Order Visibility & Uncertainty Safeguards", () => {
    it("successfully reconciles when order visibility is delayed on the first check but visible on the second", async () => {
      let queryCount = 0;
      mock.method(http as any, "get", async (url: string) => {
        if (url.includes("/api/v2/mix/order/detail")) {
          queryCount++;
          if (queryCount === 1) {
            // First check: order not indexed yet due to read replica lag
            return {
              data: {
                code: "40768",
                msg: "order does not exist",
              },
            };
          }
          // Second check: order indexed and now visible
          return {
            data: {
              code: "00000",
              data: {
                orderId: "bg-delayed-visible-999",
                clientOid: "sc_delayed_order",
              },
            },
          };
        }
        throw new Error(`Unexpected GET ${url}`);
      });

      const res = await reconcileOrderByClientOrderId("bitget", credentials, "BTCUSDT", "sc_delayed_order", 10);
      assert.notEqual(res, "NOT_FOUND", "Should not declare NOT_FOUND when order becomes visible on second check");
      assert.notEqual(res, "UNRESOLVED");
      if (typeof res === "object") {
        assert.equal(res.orderId, "bg-delayed-visible-999");
      }
      assert.equal(queryCount, 2, "Must perform second check after grace period");
    });

    it("returns UNRESOLVED and preserves AMBIGUOUS_OUTCOME when order status remains uncertain", async () => {
      mockBitgetContract();

      let postCount = 0;
      mock.method(http as any, "post", async () => {
        postCount++;
        const timeoutErr: any = new Error("timeout of 8000ms exceeded");
        timeoutErr.isAxiosError = true;
        timeoutErr.code = "ECONNABORTED";
        throw timeoutErr;
      });

      // Reconciliation fails with a network or server error (status uncertain)
      mock.method(http as any, "get", async (url: string) => {
        if (url.includes("/api/v2/mix/market/contracts")) {
          return {
            data: {
              code: "00000",
              data: [
                {
                  symbol: "BTCUSDT",
                  minTradeNum: "0.001",
                  minTradeUSDT: "5",
                  priceEndStep: "1",
                  pricePlace: "1",
                  sizeMultiplier: "0.001",
                  symbolStatus: "normal",
                },
              ],
            },
          };
        }
        if (url.includes("/api/v2/mix/order/detail")) {
          const err: any = new Error("Bad Gateway during reconciliation");
          err.isAxiosError = true;
          err.response = { status: 502, data: "Bad Gateway" };
          throw err;
        }
        throw new Error(`Unexpected GET ${url}`);
      });

      try {
        await placeOrder("bitget", params);
        assert.fail("Should have thrown");
      } catch (err: any) {
        assert.equal(err.name, "OrderExecutionError");
        assert.equal(err.classification, "AMBIGUOUS_OUTCOME");
      }

      assert.equal(postCount, 1, "Must never resubmit another order to resolve uncertainty");
    });
  });
});
