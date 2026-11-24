import test from "node:test";
import assert from "node:assert/strict";
import { assertSymbolFree, getFuturesContext, configureLeverage, refreshAvailableFuturesBalance, futuresSymbol } from "../src/services/futuresExchangeService.js";
import { calculateTradeRisk, TradeRiskError } from "../src/services/tradeRiskService.js";
import type { ExchangeId } from "../src/types/index.js";
import type { ExchangeRequest } from "../src/services/exchangeApiService.js";
import { exchangeApi } from "../src/services/exchangeApiService.js";
import { http, validateCredentials } from "../src/services/exchangeConnectionService.js";

const credentials = { apiKey: "test-key", apiSecret: "test-secret", passphrase: "test-passphrase" };
function fixture(exchange: ExchangeId) {
  const calls: Array<{ method: string; path: string; values: any }> = [];
  let leverage = "1", occupied = false, rejectLeverage = false;
  const responses: Record<string, any> = exchange === "bybit" ? {
    "/v5/market/instruments-info": { result: { list: [{ symbol: "BTCUSDT", status: "Trading", settleCoin: "USDT", quoteCoin: "USDT", contractType: "LinearPerpetual", lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001", maxOrderQty: "100", maxMktOrderQty: "50", minNotionalValue: "5" }, priceFilter: { tickSize: "0.1" }, leverageFilter: { minLeverage: "1", maxLeverage: "100", leverageStep: "1" } }] } },
    "/v5/account/wallet-balance": { result: { list: [{ totalAvailableBalance: "50", totalEquity: "1000", coin: [{ coin: "USDT", walletBalance: "1000", equity: "1000", locked: "0", totalPositionIM: "950", totalOrderIM: "0" }] }] } },
    "/v5/account/info": { result: { marginMode: "ISOLATED_MARGIN" } },
    "/v5/account/fee-rate": { result: { list: [{ takerFeeRate: "0.0006" }] } },
    "/v5/market/risk-limit": { result: { list: [{ symbol: "BTCUSDT", isLowestRisk: 1, riskLimitValue: "1000000", maxLeverage: "100", maintenanceMargin: "0.005", mmDeduction: "0", initialMargin: "0.01" }] } },
    "/v5/order/realtime": { result: { list: [] } },
  } : exchange === "okx" ? {
    "/api/v5/public/instruments": { data: [{ instId: "BTC-USDT-SWAP", state: "live", ctType: "linear", settleCcy: "USDT", ctValCcy: "BTC", ctVal: "0.01", ctMult: "1", lotSz: "0.01", minSz: "0.01", maxLmtSz: "10000", maxMktSz: "1000", tickSz: "0.1", lever: "100" }] },
    "/api/v5/account/balance": { data: [{ details: [{ ccy: "USDT", eq: "1000", availEq: "50" }] }] },
    "/api/v5/account/config": { data: [{ posMode: "net_mode", acctLv: "2" }] },
    "/api/v5/account/trade-fee": { data: [{ takerU: "-0.0006" }] },
    "/api/v5/public/position-tiers": { data: [{ minSz: "0", maxSz: "10000", maxLever: "100", mmr: "0.005", imr: "0.01" }] },
    "/api/v5/trade/orders-pending": { data: [] }, "/api/v5/trade/orders-algo-pending": { data: [] },
  } : {
    "/api/v2/mix/market/contracts": { data: [{ symbol: "BTCUSDT", symbolStatus: "normal", symbolType: "perpetual", quoteCoin: "USDT", supportMarginCoins: ["USDT"], sizeMultiplier: "0.001", minTradeNum: "0.001", maxOrderQty: "100", maxMarketOrderQty: "50", minTradeUSDT: "5", priceEndStep: "1", pricePlace: "1", takerFeeRate: "0.0006", minLever: "1", maxLever: "100", openCostUpRatio: "0.1" }] },
    "/api/v2/mix/market/query-position-lever": { data: [{ startUnit: "0", endUnit: "1000000", leverage: "100", keepMarginRate: "0.005" }] },
    "/api/v2/mix/order/orders-pending": { data: { entrustedList: [] } },
    "/api/v2/mix/order/orders-plan-pending": { data: { entrustedList: [] } },
  };
  const request: ExchangeRequest = async (method, path, values = {}) => {
    calls.push({ method, path, values });
    if (method === "POST") {
      if (rejectLeverage) throw new TradeRiskError("LEVERAGE_REJECTED", "Exchange refused leverage.");
      leverage = values.buyLeverage || values.lever || values.leverage;
      return {};
    }
    if (path === "/v5/position/list") return { result: { list: [{ positionIdx: 0, size: occupied ? "1" : "0", leverage }] } };
    if (path === "/api/v5/account/positions") return { data: occupied ? [{ pos: "1" }] : [] };
    if (path === "/api/v5/account/leverage-info") return { data: [{ lever: leverage, mgnMode: "isolated" }] };
    if (path === "/api/v2/mix/position/single-position") return { data: occupied ? [{ total: "1", posMode: "one_way_mode" }] : [] };
    if (path === "/api/v2/mix/account/account") return { data: { available: "1", crossedMaxAvailable: "50", isolatedMaxAvailable: "50", accountEquity: "1000", posMode: "one_way_mode", assetMode: "single", marginMode: "isolated", crossedMarginLeverage: leverage, isolatedLongLever: leverage, isolatedShortLever: leverage } };
    if (!(path in responses)) throw new Error(`Unexpected request: ${path}`);
    return responses[path];
  };
  return { request, calls, responses, occupy: () => { occupied = true; }, reject: () => { rejectLeverage = true; } };
}
for (const exchange of ["bybit", "okx", "bitget"] as const) test(`${exchange}: actual opening balance, native units and its own leverage API`, async () => {
  const f = fixture(exchange);
  const context = await getFuturesContext(exchange, credentials, "BTCUSDT", f.request);
  assert.equal(context.availableBalance, "50");
  assert.equal(context.accountBalance, "1000");
  const sizing = calculateTradeRisk({ exchange, ...context, entry: "64755.1", sl: "64949.3", tp: "64000", direction: "sell" });
  await configureLeverage(exchange, credentials, context, sizing, f.request);
  const mutation = f.calls.find(call => call.method === "POST")!;
  assert.equal(mutation.path, exchange === "bybit" ? "/v5/position/set-leverage" : exchange === "okx" ? "/api/v5/account/set-leverage" : "/api/v2/mix/account/set-leverage");
  if (exchange === "bybit") assert.equal(mutation.values.buyLeverage, mutation.values.sellLeverage);
  if (exchange === "okx") { assert.equal(mutation.values.mgnMode, "isolated"); assert.equal(mutation.values.instId, "BTC-USDT-SWAP"); }
  if (exchange === "bitget") assert.equal(mutation.values.productType, "USDT-FUTURES");
  assert.equal(await refreshAvailableFuturesBalance(exchange, credentials, context, f.request), "50");
  f.occupy();
  await assert.rejects(configureLeverage(exchange, credentials, context, sizing, f.request), /already has a position/);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});

test("Bybit isolated balance subtracts position margin, order margin and locked funds", async () => {
  const f = fixture("bybit");
  f.responses["/v5/account/info"].result.marginMode = "ISOLATED_MARGIN";
  assert.equal((await getFuturesContext("bybit", credentials, "BTCUSDT", f.request)).availableBalance, "50");
  f.responses["/v5/account/wallet-balance"].result.list[0].coin[0].totalOrderIM = undefined;
  await assert.rejects(getFuturesContext("bybit", credentials, "BTCUSDT", f.request), /Order margin.*unavailable/);
});

test("Bitget successful null order lists permit planning and the leverage recheck", async () => {
  for (const endId of [undefined, null, ""]) {
    const f = fixture("bitget");
    for (const path of ["/api/v2/mix/order/orders-pending", "/api/v2/mix/order/orders-plan-pending"]) {
      f.responses[path] = { code: "00000", data: { entrustedList: null, endId } };
    }
    const context = await getFuturesContext("bitget", credentials, "BTCUSDT", f.request);
    assert.equal(context.availableBalance, "50");
    const sizing = calculateTradeRisk({ exchange: "bitget", ...context, entry: "64755.1", sl: "64949.3", tp: "64000", direction: "sell" });
    await configureLeverage("bitget", credentials, context, sizing, f.request);
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
    f.responses["/api/v2/mix/order/orders-plan-pending"].data.entrustedList = [{ orderId: "existing-stop" }];
    await assert.rejects(configureLeverage("bitget", credentials, context, sizing, f.request), (error: unknown) =>
      error instanceof TradeRiskError && error.code === "EXISTING_EXPOSURE");
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
    f.occupy();
    await assert.rejects(getFuturesContext("bitget", credentials, "BTCUSDT", f.request), (error: unknown) =>
      error instanceof TradeRiskError && error.code === "EXISTING_EXPOSURE");
  }
});

test("Bitget malformed order responses remain unverifiable and log only response types", async t => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  for (const path of ["/api/v2/mix/order/orders-pending", "/api/v2/mix/order/orders-plan-pending"]) {
    for (const response of [{}, { data: null }, { data: {} }, { data: [] },
      { code: "00000", data: { entrustedList: {} } }, { code: "00000", data: { entrustedList: "private-response-value" } },
      { code: "40001", data: { entrustedList: null } }, { data: { entrustedList: null } },
      { code: "00000", data: { entrustedList: null, endId: "existing-order" } }]) {
      const f = fixture("bitget");
      f.responses[path] = response;
      await assert.rejects(assertSymbolFree("bitget", f.request, "BTCUSDT"), (error: unknown) =>
        error instanceof TradeRiskError && error.code === "INVALID_EXCHANGE_RESPONSE");
      assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
    }
  }
  assert.equal(warnings.length, 18);
  assert.ok(!JSON.stringify(warnings).includes("private-response-value"));
});

test("Bitget nonempty entry and protection order lists still block a new trade", async () => {
  for (const path of ["/api/v2/mix/order/orders-pending", "/api/v2/mix/order/orders-plan-pending"]) {
    const f = fixture("bitget");
    f.responses[path] = { code: "00000", data: { entrustedList: [{ orderId: "existing-order" }] } };
    await assert.rejects(getFuturesContext("bitget", credentials, "BTCUSDT", f.request), (error: unknown) =>
      error instanceof TradeRiskError && error.code === "EXISTING_EXPOSURE");
    assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
  }
});

for (const exchange of ["bybit", "okx", "bitget"] as const) test(`${exchange}: exchange API failures cannot yield an assumed-safe context`, async () => {
  const f = fixture(exchange);
  const request: ExchangeRequest = async (method, path, values, allowed) => {
    if (path.includes("risk-limit") || path.includes("position-tiers") || path.includes("query-position-lever")) throw new Error("Margin tier API unavailable");
    return f.request(method, path, values, allowed);
  };
  await assert.rejects(getFuturesContext(exchange, credentials, "BTCUSDT", request), /Margin tier API unavailable/);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
});

test("Bybit and Bitget reject cross margin rather than use isolated formulas", async () => {
  const bybit = fixture("bybit");
  bybit.responses["/v5/account/info"].result.marginMode = "REGULAR_MARGIN";
  await assert.rejects(getFuturesContext("bybit", credentials, "BTCUSDT", bybit.request), /requires isolated/);
  const bitget = fixture("bitget");
  const request: ExchangeRequest = async (...args) => {
    const result = await bitget.request(...args);
    if (args[1] === "/api/v2/mix/account/account") result.data.marginMode = "crossed";
    return result;
  };
  await assert.rejects(getFuturesContext("bitget", credentials, "BTCUSDT", request), /requires isolated/);
});

test("incomplete Bybit and OKX tier responses cannot establish liquidation safety", async () => {
  const bybit = fixture("bybit");
  delete bybit.responses["/v5/market/risk-limit"].result.list[0].isLowestRisk;
  await assert.rejects(getFuturesContext("bybit", credentials, "BTCUSDT", bybit.request), /lowest maintenance tier/);
  const okx = fixture("okx");
  delete okx.responses["/api/v5/public/position-tiers"].data[0].minSz;
  await assert.rejects(getFuturesContext("okx", credentials, "BTCUSDT", okx.request), /Tier minimum contracts.*unavailable/);
});

test("unknown portfolio or hedge modes are rejected without silently changing account modes", async () => {
  const f = fixture("okx");
  f.responses["/api/v5/account/config"].data[0].posMode = "long_short_mode";
  await assert.rejects(getFuturesContext("okx", credentials, "BTCUSDT", f.request), /one-way/);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
  assert.equal(futuresSymbol("okx", "BTC/USDT"), "BTC-USDT-SWAP");
});

test("Bitget account-mode rejection identifies the setting without logging account contents", async t => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  for (const [field, value, message] of [
    ["posMode", "hedge_mode", /Hedge Mode.*One-way Mode/],
    ["posMode", undefined, /did not confirm One-way Mode \(posMode\)/],
    ["assetMode", "multi", /Multi-asset Mode.*Single-asset Mode/],
    ["assetMode", undefined, /did not confirm Single-asset Mode \(assetMode\)/],
    ["marginMode", "private-account-value", /supported marginMode/],
  ] as const) {
    const f = fixture("bitget");
    const request: ExchangeRequest = async (...args) => {
      const result = await f.request(...args);
      if (args[1] === "/api/v2/mix/account/account") result.data[field] = value;
      return result;
    };
    await assert.rejects(getFuturesContext("bitget", credentials, "BTCUSDT", request), (error: unknown) =>
      error instanceof TradeRiskError && error.code === "UNSUPPORTED_ACCOUNT_MODE" && message.test(error.message));
    assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
  }
  assert.equal(warnings.length, 5);
  assert.ok(!JSON.stringify(warnings).includes("private-account-value"));
});

test("exchange transport signs all three formats and uses demo headers only in testnet", async t => {
  const previous = process.env.EXCHANGE_MODE;
  try {
    t.mock.method(http, "get", async () => ({ data: { retCode: 0, time: 123456789 } }));
    let options: any;
    t.mock.method(http, "request", async (value: any) => { options = value; return { data: value.url.includes("bybit") ? { retCode: 0 } : { code: value.url.includes("okx") ? "0" : "00000", data: [] } }; });
    for (const mode of ["testnet", "live"]) {
      process.env.EXCHANGE_MODE = mode;
      for (const exchange of ["bybit", "okx", "bitget"] as const) {
        await exchangeApi(exchange, credentials)("POST", "/test", { leverage: "5" });
        assert.equal(options["axios-retry"].retries, 0);
        assert.equal(options.headers[exchange === "bybit" ? "X-BAPI-API-KEY" : exchange === "okx" ? "OK-ACCESS-KEY" : "ACCESS-KEY"], credentials.apiKey);
        if (exchange !== "bybit") assert.equal(options.headers[exchange === "okx" ? "x-simulated-trading" : "paptrading"], mode === "testnet" ? "1" : undefined);
      }
    }
  } finally { if (previous === undefined) delete process.env.EXCHANGE_MODE; else process.env.EXCHANGE_MODE = previous; }
});

test("connection validation requires derivatives permissions, including Bitget positions", async t => {
  let bybitPermission = true, okxPermission = true, bitgetPermission = true, futuresRead = 0;
  t.mock.method(http, "get", async (url: string) => ({
    data: url.endsWith("/v5/market/time") ? { retCode: 0, time: Date.now() }
      : url.includes("/v5/user/query-api") ? { retCode: 0, result: { readOnly: 0, permissions: { ContractTrade: bybitPermission ? ["Order", "Position"] : ["Order"] } } }
      : url.includes("/api/v5/account/config") ? { code: "0", data: [{ perm: okxPermission ? "read_only,trade" : "read_only", acctLv: "2", posMode: "net_mode" }] }
      : { code: "00000", data: { userId: "123", authorities: bitgetPermission ? ["coow", "cpow"] : ["stow", "coow"] } },
  }));
  t.mock.method(http, "request", async () => { futuresRead++; return { data: { code: "00000", data: [] } }; });
  for (const exchange of ["bybit", "okx", "bitget"] as const) await validateCredentials(exchange, credentials);
  assert.equal(futuresRead, 1);
  bybitPermission = false; okxPermission = false; bitgetPermission = false;
  await assert.rejects(validateCredentials("bybit", credentials), /derivatives trading permission/);
  await assert.rejects(validateCredentials("okx", credentials), /Trade permission/);
  await assert.rejects(validateCredentials("bitget", credentials), /futures order and position/);
  assert.equal(futuresRead, 1);
});
