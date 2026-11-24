import type { ExchangeId, RawCredentials } from "../types/index.js";
import { exchangeApi, type ExchangeRequest } from "./exchangeApiService.js";
import {
  D,
  decimal,
  TradeRiskError,
  type InstrumentRules,
  type RiskSnapshot,
} from "./tradeRiskService.js";

export function futuresSymbol(exchange: ExchangeId, pair: string) {
  const symbol = pair.toUpperCase().replace(/[-/]/g, "").replace(/SWAP$/, "");
  if (!/^[A-Z0-9]+USDT$/.test(symbol))
    throw new TradeRiskError(
      "UNSUPPORTED_INSTRUMENT",
      "Only linear USDT perpetual futures are supported.",
    );
  return exchange === "okx" ? symbol.replace(/USDT$/, "-USDT-SWAP") : symbol;
}

export interface FuturesContext {
  availableBalance: string;
  accountBalance: string;
  takerFeeRate: string;
  marginMode: string;
  rules: InstrumentRules;
}
const rejectMode = () =>
  new TradeRiskError(
    "UNSUPPORTED_ACCOUNT_MODE",
    "Use a supported USDT futures account in one-way position mode. Portfolio, hedge and multi-asset modes are not supported for automatic risk management.",
  );
const busy = () =>
  new TradeRiskError(
    "EXISTING_EXPOSURE",
    "This symbol already has a position, entry order or protection order on the exchange. Close or cancel it before opening another Scopytrade trade.",
  );
const unsupportedCross = () => new TradeRiskError("UNSUPPORTED_MARGIN_MODE",
  "Liquidation safety requires isolated margin. Cross account-wide exposure cannot be verified by this planner; select isolated margin on the exchange.");
function array(value: any, name: string): any[] {
  if (!Array.isArray(value))
    throw new TradeRiskError(
      "INVALID_EXCHANGE_RESPONSE",
      `${name} could not be verified.`,
    );
  return value;
}
function bitgetPendingOrders(response: any, name: string): any[] {
  const list = response?.data?.entrustedList;
  // Record only response types; account/order contents and credentials stay private.
  // An unrecognized payload cannot establish that the symbol has no open orders.
  if (!Array.isArray(list)) {
    const type = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    console.warn("[futuresExchange] Invalid Bitget pending-order response", {
      check: name, dataType: type(response?.data), listType: type(list),
    });
  }
  return array(list, name);
}
function amount(value: any, name: string, zero = false) {
  return decimal(value, name, zero).toFixed();
}

export async function assertSymbolFree(
  exchange: ExchangeId,
  api: ExchangeRequest,
  symbol: string,
) {
  if (exchange === "bybit") {
    const [positions, orders] = await Promise.all([
      api("GET", "/v5/position/list", { category: "linear", symbol }),
      api("GET", "/v5/order/realtime", {
        category: "linear",
        symbol,
        openOnly: 0,
        limit: 50,
      }),
    ]);
    const rows = array(positions.result?.list, "Bybit positions");
    if (rows.some((p) => p.positionIdx !== 0)) throw rejectMode();
    if (
      rows.some((p) => decimal(p.size, "Position size", true).gt(0)) ||
      array(orders.result?.list, "Bybit orders").length
    )
      throw busy();
  } else if (exchange === "okx") {
    const [positions, orders, stops, oco] = await Promise.all([
      api("GET", "/api/v5/account/positions", { instId: symbol }),
      api("GET", "/api/v5/trade/orders-pending", {
        instId: symbol,
        instType: "SWAP",
      }),
      api("GET", "/api/v5/trade/orders-algo-pending", {
        instId: symbol,
        ordType: "conditional",
      }),
      api("GET", "/api/v5/trade/orders-algo-pending", {
        instId: symbol,
        ordType: "oco",
      }),
    ]);
    if (
      array(positions.data, "OKX positions").some((p) =>
        new D(p.pos).abs().gt(0),
      ) ||
      [orders, stops, oco].some((r) => array(r.data, "OKX orders").length)
    )
      throw busy();
  } else {
    const params = { symbol, productType: "USDT-FUTURES" };
    const [positions, orders, stops] = await Promise.all([
      api("GET", "/api/v2/mix/position/single-position", {
        ...params,
        marginCoin: "USDT",
      }),
      api("GET", "/api/v2/mix/order/orders-pending", params),
      api("GET", "/api/v2/mix/order/orders-plan-pending", {
        ...params,
        planType: "profit_loss",
      }),
    ]);
    const rows = array(positions.data, "Bitget positions");
    if (rows.some((p) => p.posMode && p.posMode !== "one_way_mode"))
      throw rejectMode();
    if (
      rows.some((p) => decimal(p.total, "Position size", true).gt(0)) ||
      bitgetPendingOrders(orders, "Bitget orders").length ||
      bitgetPendingOrders(stops, "Bitget stops").length
    )
      throw busy();
  }
}

async function bybitContext(
  api: ExchangeRequest,
  symbol: string,
): Promise<FuturesContext> {
  const [instrument, wallet, settings, fees, limits] = await Promise.all([
    api("GET", "/v5/market/instruments-info", { category: "linear", symbol }),
    api("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" }),
    api("GET", "/v5/account/info"),
    api("GET", "/v5/account/fee-rate", { category: "linear", symbol }),
    api("GET", "/v5/market/risk-limit", { category: "linear", symbol }),
  ]);
  const info = instrument.result?.list?.find(
    (item: any) => item.symbol === symbol,
  );
  if (
    !info ||
    info.status !== "Trading" ||
    info.settleCoin !== "USDT" ||
    info.quoteCoin !== "USDT" ||
    info.contractType !== "LinearPerpetual"
  )
    throw new TradeRiskError(
      "UNSUPPORTED_INSTRUMENT",
      "Bybit requires an active linear USDT perpetual instrument.",
    );
  const riskRows = array(limits.result?.list, "Bybit risk tiers").filter(r => r.symbol === symbol)
    .sort((a, b) => decimal(a.riskLimitValue, "Tier limit").cmp(decimal(b.riskLimitValue, "Tier limit")));
  if (riskRows[0]?.isLowestRisk !== 1) throw new TradeRiskError("LIQUIDATION_UNVERIFIABLE", "Bybit did not return the lowest maintenance tier; liquidation cannot be verified.");
  const account = wallet.result?.list?.[0],
    mode = settings.result?.marginMode;
  if (!account || !["REGULAR_MARGIN", "ISOLATED_MARGIN"].includes(mode))
    throw rejectMode();
  if (mode !== "ISOLATED_MARGIN") throw unsupportedCross();
  // A single USDT collateral pool makes USD/USDT available margin unambiguous.
  if (
    array(account.coin, "Bybit balances").some(
      (c) =>
        c.coin !== "USDT" &&
        c.collateralSwitch &&
        decimal(c.equity, "Collateral equity", true).gt(0),
    )
  )
    throw rejectMode();
  const coin = account.coin.find((c: any) => c.coin === "USDT");
  if (!coin)
    throw new TradeRiskError(
      "BALANCE_UNAVAILABLE",
      "No USDT futures trading balance was returned by Bybit.",
    );
  const isolatedAvailable = () =>
    decimal(coin.walletBalance, "USDT wallet balance", true)
      .minus(decimal(coin.totalPositionIM, "Position margin", true))
      .minus(decimal(coin.totalOrderIM, "Order margin", true))
      .minus(decimal(coin.locked, "Locked balance", true))
      .minus(decimal(coin.bonus ?? "0", "Bonus", true))
      .minus(decimal(coin.spotBorrow ?? "0", "Borrowed balance", true));
  const available =
    mode === "ISOLATED_MARGIN"
      ? isolatedAvailable()
      : D.min(
          decimal(
            account.totalAvailableBalance,
            "Available futures margin",
            true,
          ),
          decimal(coin.walletBalance, "USDT wallet balance", true)
            .minus(coin.spotBorrow ?? "0")
            .minus(coin.bonus ?? "0"),
        );
  return {
    availableBalance: amount(available, "Available futures balance"),
    accountBalance: amount(coin.equity, "USDT equity", true),
    takerFeeRate: amount(
      fees.result?.list?.[0]?.takerFeeRate,
      "Bybit taker fee",
      true,
    ),
    marginMode: mode === "ISOLATED_MARGIN" ? "isolated" : "cross",
    rules: {
      symbol,
      quantityStep: amount(info.lotSizeFilter?.qtyStep, "Quantity step"),
      minimumQuantity: amount(
        info.lotSizeFilter?.minOrderQty,
        "Minimum quantity",
      ),
      maximumQuantity: D.min(
        decimal(info.lotSizeFilter?.maxOrderQty, "Maximum quantity"),
        decimal(
          info.lotSizeFilter?.maxMktOrderQty,
          "Maximum stop-exit quantity",
        ),
      ).toFixed(),
      minimumNotional: amount(
        info.lotSizeFilter?.minNotionalValue,
        "Minimum notional",
        true,
      ),
      priceTickSize: amount(info.priceFilter?.tickSize, "Price tick"),
      contractSize: "1",
      minimumLeverage: amount(
        info.leverageFilter?.minLeverage,
        "Minimum leverage",
      ),
      maximumLeverage: amount(
        info.leverageFilter?.maxLeverage,
        "Maximum leverage",
      ),
      leverageStep: amount(info.leverageFilter?.leverageStep, "Leverage step"),
      tiers: riskRows
        .map((r) => ({
          maximumNotional: amount(r.riskLimitValue, "Tier position limit"),
          maintenanceDeduction: amount(r.mmDeduction, "Bybit maintenance deduction", true),
          maximumLeverage: amount(r.maxLeverage, "Tier leverage"),
          maintenanceRate: amount(
            r.maintenanceMargin,
            "Maintenance rate",
            true,
          ),
          initialMarginRate: amount(
            r.initialMargin,
            "Initial margin rate",
            true,
          ),
        })),
    },
  };
}

async function okxContext(
  api: ExchangeRequest,
  symbol: string,
): Promise<FuturesContext> {
  const family = symbol.replace(/-SWAP$/, "");
  const [instrument, wallet, settings, fees, limits] = await Promise.all([
    api("GET", "/api/v5/public/instruments", {
      instType: "SWAP",
      instId: symbol,
    }),
    api("GET", "/api/v5/account/balance", { ccy: "USDT" }),
    api("GET", "/api/v5/account/config"),
    api("GET", "/api/v5/account/trade-fee", {
      instType: "SWAP",
      instFamily: family,
    }),
    api("GET", "/api/v5/public/position-tiers", {
      instType: "SWAP",
      tdMode: "isolated",
      instFamily: family,
    }),
  ]);
  const info = instrument.data?.find((r: any) => r.instId === symbol),
    config = settings.data?.[0];
  if (
    !info ||
    info.state !== "live" ||
    info.ctType !== "linear" ||
    info.settleCcy !== "USDT" ||
    info.ctValCcy !== family.split("-")[0]
  )
    throw new TradeRiskError(
      "UNSUPPORTED_INSTRUMENT",
      "OKX requires an active linear USDT swap with a base-asset contract value.",
    );
  if (
    !config ||
    config.posMode !== "net_mode" ||
    !["2", "3"].includes(config.acctLv)
  )
    throw rejectMode();
  const coin = wallet.data?.[0]?.details?.find((c: any) => c.ccy === "USDT");
  if (!coin)
    throw new TradeRiskError(
      "BALANCE_UNAVAILABLE",
      "No available USDT futures balance was returned by OKX.",
    );
  const available = amount(coin.availEq, "OKX available USDT equity", true);
  const contractSize = decimal(info.ctVal, "Contract value").mul(
    decimal(info.ctMult, "Contract multiplier"),
  );
  // OKX fee debits are negative numbers; rebates must never increase the risk budget.
  const taker = new D(fees.data?.[0]?.takerU ?? fees.data?.[0]?.taker);
  if (!taker.isFinite())
    throw new TradeRiskError(
      "FEE_UNAVAILABLE",
      "OKX trading fee information is unavailable.",
    );
  return {
    availableBalance: amount(available, "Available futures balance"),
    accountBalance: amount(coin.eq, "USDT equity", true),
    takerFeeRate: D.max(0, taker.neg()).toFixed(),
    marginMode: "isolated",
    rules: {
      symbol,
      quantityStep: amount(info.lotSz, "Contract step"),
      minimumQuantity: amount(info.minSz, "Minimum contracts"),
      maximumQuantity: D.min(
        decimal(info.maxLmtSz, "Maximum contracts"),
        decimal(info.maxMktSz, "Maximum stop-exit contracts"),
      ).toFixed(),
      minimumNotional: "0",
      priceTickSize: amount(info.tickSz, "Price tick"),
      contractSize: contractSize.toFixed(),
      minimumLeverage: "1",
      maximumLeverage: amount(info.lever, "Maximum leverage"),
      leverageStep: "1",
      tiers: array(limits.data, "OKX margin tiers").map((r) => ({
        minimumOrderQuantity: amount(r.minSz, "Tier minimum contracts", true),
        maximumOrderQuantity: amount(r.maxSz, "Tier contract limit"),
        maximumLeverage: amount(r.maxLever, "Tier leverage"),
        maintenanceRate: amount(r.mmr, "Maintenance rate", true),
        initialMarginRate: amount(r.imr, "Initial margin rate", true),
      })),
    },
  };
}

async function bitgetContext(
  api: ExchangeRequest,
  symbol: string,
): Promise<FuturesContext> {
  const params = { symbol, productType: "USDT-FUTURES" };
  const [instrument, wallet, limits] = await Promise.all([
    api("GET", "/api/v2/mix/market/contracts", params),
    api("GET", "/api/v2/mix/account/account", {
      ...params,
      marginCoin: "USDT",
    }),
    api("GET", "/api/v2/mix/market/query-position-lever", params),
  ]);
  const info = instrument.data?.find((r: any) => r.symbol === symbol),
    account = wallet.data;
  if (
    !info ||
    info.symbolStatus !== "normal" ||
    info.quoteCoin !== "USDT" ||
    !info.supportMarginCoins?.includes("USDT") ||
    info.symbolType !== "perpetual"
  )
    throw new TradeRiskError(
      "UNSUPPORTED_INSTRUMENT",
      "Bitget requires an active classic-account USDT perpetual futures instrument.",
    );
  if (
    !account ||
    account.posMode !== "one_way_mode" ||
    account.assetMode !== "single" ||
    !["crossed", "isolated"].includes(account.marginMode)
  )
    throw rejectMode();
  if (account.marginMode !== "isolated") throw unsupportedCross();
  const available =
    account.marginMode === "crossed"
      ? account.crossedMaxAvailable
      : account.isolatedMaxAvailable;
  return {
    availableBalance: amount(available, "Bitget available opening margin"),
    accountBalance: amount(account.accountEquity, "USDT futures equity", true),
    takerFeeRate: decimal(info.takerFeeRate, "Bitget taker fee", true)
      .mul(
        decimal(info.feeRateUpRatio ?? "0", "Fee rate allowance", true).plus(1),
      )
      .toFixed(),
    marginMode: account.marginMode,
    rules: {
      symbol,
      quantityStep: amount(info.sizeMultiplier, "Quantity step"),
      minimumQuantity: amount(info.minTradeNum, "Minimum quantity"),
      maximumQuantity: D.min(
        decimal(info.maxOrderQty, "Maximum quantity"),
        decimal(info.maxMarketOrderQty, "Maximum stop-exit quantity"),
      ).toFixed(),
      minimumNotional: amount(info.minTradeUSDT, "Minimum notional", true),
      priceTickSize: decimal(info.priceEndStep, "Price step")
        .mul(new D(10).pow(-Number(info.pricePlace)))
        .toFixed(),
      contractSize: "1",
      minimumLeverage: amount(info.minLever, "Minimum leverage"),
      maximumLeverage: amount(info.maxLever, "Maximum leverage"),
      leverageStep: "1",
      openingMarginBufferRate: amount(
        info.openCostUpRatio ?? "0",
        "Opening margin allowance",
        true,
      ),
      tiers: array(limits.data, "Bitget margin tiers").map((r) => ({
        maximumNotional: amount(r.endUnit, "Tier position limit"),
        minimumNotional: amount(r.startUnit, "Bitget tier start", true),
        maximumLeverage: amount(r.leverage, "Tier leverage"),
        maintenanceRate: amount(r.keepMarginRate, "Maintenance rate", true),
      })),
    },
  };
}

export async function getFuturesContext(
  exchange: ExchangeId,
  credentials: RawCredentials,
  pair: string,
  request = exchangeApi(exchange, credentials),
) {
  if (!["bybit", "okx", "bitget"].includes(exchange)) throw new TradeRiskError("UNSUPPORTED_EXCHANGE", "Exchange is not supported for futures planning.");
  const symbol = futuresSymbol(exchange, pair);
  await assertSymbolFree(exchange, request, symbol);
  return exchange === "bybit"
    ? bybitContext(request, symbol)
    : exchange === "okx"
      ? okxContext(request, symbol)
      : bitgetContext(request, symbol);
}

export async function configureLeverage(
  exchange: ExchangeId,
  credentials: RawCredentials,
  context: FuturesContext,
  sizing: RiskSnapshot,
  request = exchangeApi(exchange, credentials),
) {
  const symbol = context.rules.symbol,
    leverage = String(sizing.leverage);
  // Recheck before touching leverage so existing symbol exposure is never reconfigured.
  await assertSymbolFree(exchange, request, symbol);
  if (exchange === "bybit") {
    await request(
      "POST",
      "/v5/position/set-leverage",
      {
        category: "linear",
        symbol,
        buyLeverage: leverage,
        sellLeverage: leverage,
      },
      [110043],
    );
    const result = await request("GET", "/v5/position/list", {
      category: "linear",
      symbol,
    });
    if (
      !result.result?.list?.length ||
      result.result.list.some(
        (p: any) =>
          p.positionIdx !== 0 ||
          Number(p.size) !== 0 ||
          !new D(p.leverage).eq(leverage),
      )
    )
      throw new TradeRiskError(
        "LEVERAGE_VERIFICATION_FAILED",
        "Bybit did not confirm the requested one-way leverage.",
      );
  } else if (exchange === "okx") {
    await request("POST", "/api/v5/account/set-leverage", {
      instId: symbol,
      lever: leverage,
      mgnMode: "isolated",
    });
    const result = await request("GET", "/api/v5/account/leverage-info", {
      instId: symbol,
      mgnMode: "isolated",
    });
    if (
      !result.data?.length ||
      result.data.some(
        (p: any) => p.mgnMode !== "isolated" || !new D(p.lever).eq(leverage),
      )
    )
      throw new TradeRiskError(
        "LEVERAGE_VERIFICATION_FAILED",
        "OKX did not confirm isolated leverage for this swap.",
      );
  } else {
    await request("POST", "/api/v2/mix/account/set-leverage", {
      symbol,
      productType: "USDT-FUTURES",
      marginCoin: "USDT",
      leverage,
    });
    const result = await request("GET", "/api/v2/mix/account/account", {
      symbol,
      productType: "USDT-FUTURES",
      marginCoin: "USDT",
    });
    const p = result.data;
    if (
      !p ||
      p.marginMode !== context.marginMode ||
      p.posMode !== "one_way_mode" ||
      (context.marginMode === "crossed"
        ? !new D(p.crossedMarginLeverage).eq(leverage)
        : !new D(p.isolatedLongLever).eq(leverage) ||
          !new D(p.isolatedShortLever).eq(leverage))
    )
      throw new TradeRiskError(
        "LEVERAGE_VERIFICATION_FAILED",
        "Bitget did not confirm the requested leverage and margin mode.",
      );
  }
}

export async function refreshAvailableFuturesBalance(
  exchange: ExchangeId,
  credentials: RawCredentials,
  context: FuturesContext,
  request = exchangeApi(exchange, credentials),
) {
  if (exchange === "bybit") {
    const result = await request("GET", "/v5/account/wallet-balance", {
      accountType: "UNIFIED",
    });
    const account = result.result?.list?.[0],
      coin = account?.coin?.find((c: any) => c.coin === "USDT");
    if (!coin)
      throw new TradeRiskError(
        "BALANCE_UNAVAILABLE",
        "Bybit did not return an available USDT balance.",
      );
    const available =
      context.marginMode === "isolated"
        ? decimal(coin.walletBalance, "Wallet balance", true)
            .minus(decimal(coin.totalPositionIM, "Position margin", true))
            .minus(decimal(coin.totalOrderIM, "Order margin", true))
            .minus(decimal(coin.locked, "Locked balance", true))
            .minus(coin.bonus ?? "0")
            .minus(coin.spotBorrow ?? "0")
        : D.min(
            decimal(account.totalAvailableBalance, "Available margin", true),
            decimal(coin.walletBalance, "USDT balance", true)
              .minus(coin.spotBorrow ?? "0")
              .minus(coin.bonus ?? "0"),
          );
    return amount(available, "Available futures balance");
  }
  if (exchange === "okx") {
    const result = await request("GET", "/api/v5/account/balance", {
      ccy: "USDT",
    });
    return amount(
      result.data?.[0]?.details?.find((c: any) => c.ccy === "USDT")?.availEq,
      "Available futures balance",
    );
  }
  const result = await request("GET", "/api/v2/mix/account/account", {
    symbol: context.rules.symbol,
    productType: "USDT-FUTURES",
    marginCoin: "USDT",
  });
  if (
    result.data?.marginMode !== context.marginMode ||
    result.data?.posMode !== "one_way_mode"
  )
    throw rejectMode();
  return amount(
    context.marginMode === "crossed"
      ? result.data?.crossedMaxAvailable
      : result.data?.isolatedMaxAvailable,
    "Available futures balance",
  );
}
