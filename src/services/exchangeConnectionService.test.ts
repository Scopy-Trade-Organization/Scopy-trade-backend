import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AxiosError } from "axios";
import { http } from "./exchangeConnectionService.js";
import { NO_RETRY } from "./tradeService.js";

describe("Production HTTP Client (http) Retry Interceptor", () => {
  it("retries safe GET requests on network errors (e.g. ECONNRESET)", async () => {
    let callCount = 0;
    try {
      await http.get("https://api.bybit.com/v5/market/time", {
        "axios-retry": { retryDelay: () => 1 },
        adapter: async (config: any) => {
          callCount++;
          throw new AxiosError("Connection reset", "ECONNRESET", config, null, undefined);
        },
      } as any);
    } catch (err) {
      // Expected to fail after retries
    }

    assert.equal(callCount, 3, "GET request should be attempted 3 times (1 initial + 2 retries)");
  });

  it("retries safe GET requests on 5xx server errors", async () => {
    let callCount = 0;
    try {
      await http.get("https://api.bybit.com/v5/market/tickers", {
        "axios-retry": { retryDelay: () => 1 },
        adapter: async (config: any) => {
          callCount++;
          throw new AxiosError("Bad Gateway", "ERR_BAD_RESPONSE", config, null, {
            status: 502,
            statusText: "Bad Gateway",
            headers: {},
            data: {},
            config,
          } as any);
        },
      } as any);
    } catch (err) {
      // Expected to fail after retries
    }

    assert.equal(callCount, 3, "GET request should be attempted 3 times (1 initial + 2 retries)");
  });

  it("strictly forbids retries for order POST requests on network errors (exactly 1 call)", async () => {
    let callCount = 0;
    try {
      await http.post("https://api.bybit.com/v5/order/create", {}, {
        adapter: async (config: any) => {
          callCount++;
          throw new AxiosError("Connection reset", "ECONNRESET", config, null, undefined);
        },
      } as any);
    } catch (err) {
      // Expected
    }

    assert.equal(callCount, 1, "POST must never be retried on network error");
  });

  it("strictly forbids retries for order POST requests on 5xx server errors (exactly 1 call)", async () => {
    let callCount = 0;
    try {
      await http.post("https://api.bitget.com/api/v2/mix/order/place-order", {}, {
        adapter: async (config: any) => {
          callCount++;
          throw new AxiosError("Bad Gateway", "ERR_BAD_RESPONSE", config, null, {
            status: 502,
            statusText: "Bad Gateway",
            headers: {},
            data: {},
            config,
          } as any);
        },
      } as any);
    } catch (err) {
      // Expected
    }

    assert.equal(callCount, 1, "POST must never be retried on 5xx server error");
  });

  it("strictly forbids retries for mutating PUT or DELETE operations", async () => {
    let putCount = 0;
    let deleteCount = 0;

    try {
      await http.put("https://fapi.binance.com/fapi/v1/order", {}, {
        adapter: async (config: any) => {
          putCount++;
          throw new AxiosError("Bad Gateway", "ERR_BAD_RESPONSE", config, null, {
            status: 502,
            statusText: "Bad Gateway",
            headers: {},
            data: {},
            config,
          } as any);
        },
      } as any);
    } catch {}

    try {
      await http.delete("https://fapi.binance.com/fapi/v1/order", {
        adapter: async (config: any) => {
          deleteCount++;
          throw new AxiosError("Bad Gateway", "ERR_BAD_RESPONSE", config, null, {
            status: 502,
            statusText: "Bad Gateway",
            headers: {},
            data: {},
            config,
          } as any);
        },
      } as any);
    } catch {}

    assert.equal(putCount, 1, "PUT must never be retried on 5xx");
    assert.equal(deleteCount, 1, "DELETE must never be retried on 5xx");
  });

  it("honors request-level NO_RETRY even on GET requests", async () => {
    let callCount = 0;
    try {
      await http.get("https://api.bybit.com/v5/market/time", {
        ...NO_RETRY,
        adapter: async (config: any) => {
          callCount++;
          throw new AxiosError("Internal Server Error", "ERR_BAD_RESPONSE", config, null, {
            status: 500,
            statusText: "Internal Server Error",
            headers: {},
            data: {},
            config,
          } as any);
        },
      } as any);
    } catch (err) {
      // Expected
    }

    assert.equal(callCount, 1, "NO_RETRY must disable retries completely even on GET");
  });
});
