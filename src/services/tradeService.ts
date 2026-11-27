import { BITGET_CATEGORY, bitgetList, bitgetProtectionParams } from "./bitgetUtaService.js";
import {
  verifyOrRecoverProtection,
  readEntry,
  readConfirmedExit,
  position,
  setBitgetPositionProtection,
} from "./tradeProtectionService.js";
import { D, decimal, TradeRiskError, type RiskSnapshot } from "./tradeRiskService.js";
import { exchangeApi } from "./exchangeApiService.js";
import crypto from "crypto";
import { RawCredentials, ExchangeId } from "../types/index.js";
import {
  http,
  normalizeError,
  getBybitTimestamp,
} from "./exchangeConnectionService.js";
import {
  getExchangeRestUrl,
  isBitgetDemo,
  isOkxDemo,
} from "./exchangeEnvironment.js";

// ─── Order Types ──────────────────────────────────────────────────────────────

export interface PlaceOrderParams {
  credentials: RawCredentials;
  pair: string; // e.g. "BTCUSDT"
  direction: "buy" | "sell";
  clientOrderId?: string;
  quantity: string; // base asset quantity
  entryPrice: string; // limit price
  tp: string;
  sl: string;
  sizing?: RiskSnapshot;
  marginMode?: string;
}

export interface PlacedOrderResult {
  orderId: string;
  raw: unknown;
  execution?: {
    quantity: string;
    entryPrice: string;
    tp: string;
    sl: string;
  };
}

export interface OrderStatusResult {
  status: "pending" | "filled" | "closed" | "cancelled" | "failed";
  filledPrice: string | null;
  raw: unknown;
}

export interface CurrentPriceResult {
  price: string;
  raw: unknown;
}

export interface AmendTradeParams extends PlaceOrderParams {
  orderId: string;
  status: "pending" | "filled";
  protectionOrderIds?: string[];
  protectionTransport?: "algo" | "legacy" | null;
  entryChanged?: boolean;
  protectionChanged?: boolean;
}

export interface AmendTradeResult {
  orderId?: string;
  entryPrice: string;
  tp: string;
  sl: string;
  protectionOrderIds?: string[];
  protectionTransport?: "algo" | "legacy";
  raw: unknown;
}

export interface ManualCloseParams {
  credentials: RawCredentials;
  pair: string;
  direction: "buy" | "sell";
  quantity: string;
  orderId: string;
  status: "pending" | "filled";
  sizing?: RiskSnapshot;
}

export interface ManualCloseResult {
  status: "cancelled" | "closed";
  exitPrice: string | null;
  closedQuantity?: string;
  entryFillPrice?: string;
  raw: unknown;
}

// ─── Balance Types ────────────────────────────────────────────────────────────

export interface AssetBalance {
  asset: string;
  free: string;
  locked: string;
}

export interface ExchangeBalance {
  balances: AssetBalance[]; // non-zero assets only
  totalUsdtEquivalent: string | null; // provided natively by some exchanges
}

// ─── Pair Normalization ──────────────────────────────────────────────────────

function normalizePairForExchange(exchange: ExchangeId, pair: string): string {
  const symbol = pair.toUpperCase().replace(/[-/]/g, "").replace(/SWAP$/, "");
  if (!/^[A-Z0-9]+USDT$/.test(symbol))
    throw new Error("Only linear USDT futures are supported.");
  return exchange === "okx" ? symbol.replace(/USDT$/, "-USDT-SWAP") : symbol;
}

async function prepareFuturesOrder(
  _exchange: ExchangeId,
  p: PlaceOrderParams,
): Promise<PlaceOrderParams> {
  if (!p.sizing)
    throw new TradeRiskError(
      "RISK_PLAN_REQUIRED",
      "A backend risk plan is required before placing or amending futures orders.",
    );
  return {
    ...p,
    quantity: p.sizing.positionQuantity,
    entryPrice: p.sizing.entryPrice,
    tp: p.sizing.takeProfitPrice,
    sl: p.sizing.stopLossPrice,
  };
}

// ─── Order Placement ──────────────────────────────────────────────────────────

async function placeBybitOrder(
  p: PlaceOrderParams,
): Promise<PlacedOrderResult> {
  const raw = await exchangeApi("bybit", p.credentials)(
    "POST",
    "/v5/order/create",
    {
      category: "linear",
      symbol: normalizePairForExchange("bybit", p.pair),
      orderLinkId: p.clientOrderId,
      side: p.direction === "buy" ? "Buy" : "Sell",
      orderType: "Limit",
      qty: p.sizing!.orderQuantity,
      price: p.entryPrice,
      takeProfit: p.tp,
      stopLoss: p.sl,
      tpslMode: "Full",
      tpOrderType: "Market",
      slOrderType: "Market",
      tpTriggerBy: "MarkPrice",
      slTriggerBy: "MarkPrice",
      timeInForce: "GTC",
      positionIdx: 0,
    },
  );
  return { orderId: String(raw.result?.orderId || ""), raw };
}

async function placeOkxOrder(p: PlaceOrderParams): Promise<PlacedOrderResult> {
  const api = exchangeApi("okx", p.credentials);
  const result = await api("POST", "/api/v5/trade/order", {
    instId: normalizePairForExchange("okx", p.pair),
    tdMode: "isolated",
    posSide: "net",
    side: p.direction,
    ordType: "limit",
    sz: p.sizing!.orderQuantity,
    px: p.entryPrice,
    clOrdId: p.clientOrderId,
    attachAlgoOrds: [
      {
        attachAlgoClOrdId: `${p.clientOrderId}s`,
        tpTriggerPx: p.tp,
        tpOrdPx: "-1",
        slTriggerPx: p.sl,
        slOrdPx: "-1",
        tpTriggerPxType: "mark",
        slTriggerPxType: "mark",
      },
    ],
  });
  const orderId = result.data?.[0]?.ordId;
  if (!orderId)
    throw new TradeRiskError(
      "ORDER_REVIEW_REQUIRED",
      "OKX did not return an order ID. Check the exchange before retrying.",
    );
  return { orderId: String(orderId), raw: result };
}

async function placeBitgetOrder(
  p: PlaceOrderParams,
): Promise<PlacedOrderResult> {
  const raw = await exchangeApi("bitget", p.credentials)(
    "POST",
    "/api/v3/trade/place-order",
    {
      symbol: normalizePairForExchange("bitget", p.pair),
      category: BITGET_CATEGORY,
      marginMode: "isolated",
      qty: p.sizing!.orderQuantity,
      price: p.entryPrice,
      side: p.direction,
      orderType: "limit",
      timeInForce: "gtc",
      clientOid: p.clientOrderId,
      ...bitgetProtectionParams(p.tp, p.sl),
    },
  );
  return { orderId: String(raw.data?.orderId || ""), raw };
}

async function getBybitCurrentPrice(pair: string): Promise<CurrentPriceResult> {
  const baseUrl = getExchangeRestUrl("bybit");
  const normalizedPair = normalizePairForExchange("bybit", pair);

  const { data } = await http.get(`${baseUrl}/v5/market/tickers`, {
    params: { category: "linear", symbol: normalizedPair },
  });

  if (data.retCode !== 0)
    throw new Error(data.retMsg || "Bybit ticker failed.");
  const ticker = data.result?.list?.[0];
  if (!ticker?.lastPrice) throw new Error("Bybit returned an invalid ticker.");

  return { price: String(ticker.lastPrice), raw: data };
}

async function getOkxCurrentPrice(pair: string): Promise<CurrentPriceResult> {
  const normalizedPair = normalizePairForExchange("okx", pair);

  const { data } = await http.get(
    getExchangeRestUrl("okx") + "/api/v5/market/ticker",
    {
      params: { instId: normalizedPair },
    },
  );

  if (data.code !== "0") throw new Error(data.msg || "OKX ticker failed.");
  const ticker = data.data?.[0];
  if (!ticker?.last) throw new Error("OKX returned an invalid ticker.");

  return { price: String(ticker.last), raw: data };
}

async function getBitgetCurrentPrice(
  pair: string,
): Promise<CurrentPriceResult> {
  const normalizedPair = normalizePairForExchange("bitget", pair);

  const { data } = await http.get(
    getExchangeRestUrl("bitget") + "/api/v3/market/tickers",
    {
      params: { symbol: normalizedPair, category: BITGET_CATEGORY },
      headers: {
        ...(isBitgetDemo() ? { paptrading: "1" } : {}),
      },
    },
  );

  if (data.code !== "00000")
    throw new Error(data.msg || "Bitget ticker failed.");
  const ticker = data.data?.[0];
  if (!ticker?.lastPrice) throw new Error("Bitget returned an invalid ticker.");

  return { price: String(ticker.lastPrice), raw: data };
}

// ─── Balance Fetchers ─────────────────────────────────────────────────────────

async function getBybitBalance(
  credentials: RawCredentials,
): Promise<ExchangeBalance> {
  const { apiKey, apiSecret } = credentials;
  const baseUrl = getExchangeRestUrl("bybit");

  try {
    const timestamp = await getBybitTimestamp(baseUrl);
    const recvWindow = "5000";
    const queryString = "accountType=UNIFIED";
    const signPayload = timestamp + apiKey + recvWindow + queryString;
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(signPayload)
      .digest("hex");

    interface BybitBalanceResponse {
      retCode: number;
      retMsg: string;
      result: {
        list: Array<{
          totalEquity: string;
          coin: Array<{
            coin: string;
            walletBalance: string;
            locked: string;
          }>;
        }>;
      };
    }

    const { data } = await http.get<BybitBalanceResponse>(
      `${baseUrl}/v5/account/wallet-balance`,
      {
        params: { accountType: "UNIFIED" },
        headers: {
          "X-BAPI-API-KEY": apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
        },
      },
    );

    if (data.retCode !== 0)
      throw new Error(data.retMsg || "Bybit balance fetch failed.");

    const account = data.result.list[0];
    if (!account) throw new Error("Bybit returned an empty wallet response.");

    const nonZero = account.coin.filter((c) => parseFloat(c.walletBalance) > 0);

    return {
      balances: nonZero.map((c) => ({
        asset: c.coin,
        free: String(parseFloat(c.walletBalance) - parseFloat(c.locked || "0")),
        locked: c.locked || "0",
      })),
      totalUsdtEquivalent: account.totalEquity || null,
    };
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.retMsg || err?.message;

    if (status === 401 || status === 403) {
      throw new Error("Bybit: Insufficient permissions");
    }

    throw new Error(`Bybit error: ${msg || "Unknown error"}`);
  }
}

async function getOkxBalance(
  credentials: RawCredentials,
): Promise<ExchangeBalance> {
  const { apiKey, apiSecret, passphrase } = credentials;
  if (!passphrase) throw new Error("OKX requires a passphrase.");

  const timestamp = new Date().toISOString();
  const method = "GET";
  const path = "/api/v5/account/balance";
  const signPayload = timestamp + method + path;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("base64");

  interface OkxBalanceResponse {
    code: string;
    msg: string;
    data: Array<{
      totalEq: string;
      details: Array<{
        ccy: string;
        availBal: string;
        frozenBal: string;
      }>;
    }>;
  }

  const { data } = await http.get<OkxBalanceResponse>(
    getExchangeRestUrl("okx") + path,
    {
      headers: {
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": passphrase,
        ...(isOkxDemo() ? { "x-simulated-trading": "1" } : {}),
      },
    },
  );

  if (data.code !== "0")
    throw new Error(data.msg || "OKX balance fetch failed.");

  const account = data.data[0];
  if (!account) throw new Error("OKX returned an empty balance response.");

  const nonZero = account.details.filter(
    (d) => parseFloat(d.availBal) > 0 || parseFloat(d.frozenBal) > 0,
  );

  return {
    balances: nonZero.map((d) => ({
      asset: d.ccy,
      free: d.availBal,
      locked: d.frozenBal,
    })),
    totalUsdtEquivalent: account.totalEq || null,
  };
}

const decimalBalance = (value: any) => decimal(value, "Bitget UTA balance", true);

async function getBitgetBalance(
  credentials: RawCredentials,
): Promise<ExchangeBalance> {
  const data = await exchangeApi("bitget", credentials)("GET", "/api/v3/account/assets");
  const assets = bitgetList(data.data?.assets, "assets");
  return {
    balances: assets.filter(a => decimalBalance(a.available).gt(0) || decimalBalance(a.locked).gt(0)).map(a => ({
      asset: a.coin, free: decimalBalance(a.available).toFixed(), locked: decimalBalance(a.locked).toFixed(),
    })),
    totalUsdtEquivalent: decimalBalance(data.data?.usdtEquity).toFixed(),
  };
}

// ─── Order Registry ───────────────────────────────────────────────────────────

const orderPlacer: Record<
  ExchangeId,
  (p: PlaceOrderParams) => Promise<PlacedOrderResult>
> = {
  bybit: placeBybitOrder,
  okx: placeOkxOrder,
  bitget: placeBitgetOrder,
};

const priceFetcher: Record<
  ExchangeId,
  (pair: string) => Promise<CurrentPriceResult>
> = {
  bybit: getBybitCurrentPrice,
  okx: getOkxCurrentPrice,
  bitget: getBitgetCurrentPrice,
};

const balanceFetcher: Record<
  ExchangeId,
  (credentials: RawCredentials) => Promise<ExchangeBalance>
> = {
  bybit: getBybitBalance,
  okx: getOkxBalance,
  bitget: getBitgetBalance,
};

// ─── Public Trading API ──────────────────────────────────────────────────────

export async function placeOrder(
  exchange: ExchangeId,
  params: PlaceOrderParams,
): Promise<PlacedOrderResult> {
  try {
    if (!params.sizing || !params.marginMode)
      throw new TradeRiskError(
        "RISK_PLAN_REQUIRED",
        "A verified backend risk and leverage plan is required before opening a futures order.",
      );
    const prepared = await prepareFuturesOrder(exchange, params);
    const placed = await orderPlacer[exchange](prepared);
    return {
      ...placed,
      execution: {
        quantity: prepared.quantity,
        entryPrice: prepared.entryPrice,
        tp: prepared.tp,
        sl: prepared.sl,
      },
    };
  } catch (err) {
    throw normalizeError(err);
  }
}

export async function amendTradeOrder(
  exchange: ExchangeId,
  params: AmendTradeParams,
): Promise<AmendTradeResult> {
  const p = await prepareFuturesOrder(exchange, params);
  const api = exchangeApi(exchange, p.credentials),
    symbol = normalizePairForExchange(exchange, p.pair);
  let result: AmendTradeResult = {
    entryPrice: p.entryPrice,
    tp: p.tp,
    sl: p.sl,
    raw: { amendmentResponseUnconfirmed: true },
  };
  try {
    if (exchange === "bybit") {
      const raw = await api(
        "POST",
        params.status === "pending"
          ? "/v5/order/amend"
          : "/v5/position/trading-stop",
        {
          category: "linear",
          symbol,
          ...(params.status === "pending"
            ? { orderId: params.orderId, price: p.entryPrice }
            : { positionIdx: 0 }),
          takeProfit: p.tp,
          stopLoss: p.sl,
          tpslMode: "Full",
          tpOrderType: "Market",
          slOrderType: "Market",
          tpTriggerBy: "MarkPrice",
          slTriggerBy: "MarkPrice",
        },
      );
      result = { entryPrice: p.entryPrice, tp: p.tp, sl: p.sl, raw };
    } else if (exchange === "bitget" && params.status === "pending") {
      const raw = await api("POST", "/api/v3/trade/modify-order", {
        symbol, category: BITGET_CATEGORY, orderId: params.orderId,
        price: p.entryPrice, autoCancel: "no", ...bitgetProtectionParams(p.tp, p.sl),
      });
      result = { entryPrice: p.entryPrice, tp: p.tp, sl: p.sl, raw };
    } else if (exchange === "okx" && params.status === "pending") {
      const entry = await readEntry(exchange, api, symbol, params.orderId);
      const attachment = entry.row.attachAlgoOrds?.[0];
      const attachId = attachment?.attachAlgoId;
      const attachClientId =
        attachment?.attachAlgoClOrdId ||
        (p.clientOrderId ? `${p.clientOrderId}s` : undefined);
      if (params.protectionChanged && !attachId && !attachClientId)
        throw new TradeRiskError(
          "PROTECTION_ID_UNAVAILABLE",
          "OKX did not return the protection identity. No amendment was submitted.",
        );
      const raw = await api("POST", "/api/v5/trade/amend-order", {
        instId: symbol,
        ordId: params.orderId,
        newPx: p.entryPrice,
        ...(params.protectionChanged
          ? {
              attachAlgoOrds: [
                {
                  ...(attachId
                    ? { attachAlgoId: attachId }
                    : { attachAlgoClOrdId: attachClientId }),
                  newTpTriggerPx: p.tp,
                  newTpOrdPx: "-1",
                  newSlTriggerPx: p.sl,
                  newSlOrdPx: "-1",
                  newTpTriggerPxType: "mark",
                  newSlTriggerPxType: "mark",
                },
              ],
            }
          : {}),
      });
      result = { entryPrice: p.entryPrice, tp: p.tp, sl: p.sl, raw };
    } else if (exchange === "okx") {
      const orders: any[] = [];
      for (const ordType of ["oco", "conditional"])
        orders.push(
          ...(
            await api("GET", "/api/v5/trade/orders-algo-pending", {
              instId: symbol,
              ordType,
            })
          ).data,
        );
      const owned = orders.filter(
        (r) =>
          p.clientOrderId &&
          String(r.algoClOrdId || r.attachAlgoClOrdId || "").startsWith(
            p.clientOrderId,
          ) &&
          r.slTriggerPx &&
          r.tpTriggerPx,
      );
      if (owned.length !== 1)
        throw new TradeRiskError(
          "PROTECTION_ID_UNAVAILABLE",
          "The OKX position protection could not be identified uniquely. No amendment was submitted.",
        );
      const raw = await api("POST", "/api/v5/trade/amend-algos", {
        instId: symbol,
        algoId: owned[0].algoId,
        newTpTriggerPx: p.tp,
        newTpOrdPx: "-1",
        newSlTriggerPx: p.sl,
        newSlOrdPx: "-1",
      });
      result = { entryPrice: p.entryPrice, tp: p.tp, sl: p.sl, raw };
    } else {
      const live = await position(exchange, api, symbol);
      if (!live || live.posSide !== (p.direction === "buy" ? "long" : "short") || new D(live.total).gt(p.sizing!.orderQuantity)) {
        throw new TradeRiskError("PROTECTION_ID_UNAVAILABLE", "Bitget UTA position changed or is unavailable. No amendment was submitted.");
      }
      await setBitgetPositionProtection(api, symbol, { direction: p.direction, tp: p.tp, sl: p.sl, clientOrderId: p.clientOrderId || "scamend" }, new D(live.total).toFixed());
      result = { entryPrice: p.entryPrice, tp: p.tp, sl: p.sl, raw: { protectionAmended: true } };
    }
  } catch (error) {
    if (
      error instanceof TradeRiskError &&
      error.code === "PROTECTION_ID_UNAVAILABLE"
    )
      throw error;
    // A failed response can follow a successful mutation. Read back the intended
    // protection and recover before deciding whether the amendment succeeded.
  }
  await verifyOrRecoverProtection(
    exchange,
    {
      credentials: p.credentials,
      pair: p.pair,
      direction: p.direction,
      orderId: result.orderId || params.orderId,
      clientOrderId: p.clientOrderId || "scamend",
      quantity: p.quantity,
      orderQuantity: p.sizing?.orderQuantity || p.quantity,
      entryPrice: p.entryPrice,
      tp: p.tp,
      sl: p.sl,
      marginMode: p.marginMode || (exchange === "okx" ? "isolated" : "crossed"),
      ...(p.sizing ? { sizing: p.sizing } : {}),
    },
    api,
  );
  return result;
}

/** Recover a lost submission response without placing another entry. */
export async function resolveExchangeOrderId(
  exchange: ExchangeId,
  credentials: RawCredentials,
  pair: string,
  clientOrderId: string | null | undefined,
  api = exchangeApi(exchange, credentials),
): Promise<string> {
  const unresolved = () => new TradeRiskError("ORDER_REVIEW_REQUIRED",
    "The exchange order could not be confirmed by its saved client order ID. Check the exchange order history before retrying; this trade remains under review.");
  // Never issue an unfiltered order lookup when both identifiers are missing.
  if (!clientOrderId) throw unresolved();
  let entry;
  try {
    entry = await readEntry(exchange, api, normalizePairForExchange(exchange, pair), "", clientOrderId);
  } catch {
    throw unresolved();
  }
  const row = entry.row;
  const returnedClientId = exchange === "bybit" ? row.orderLinkId : exchange === "okx" ? row.clOrdId : row.clientOid;
  const orderId = exchange === "okx" ? row.ordId : row.orderId;
  if (returnedClientId !== clientOrderId || typeof orderId !== "string" || !orderId.trim()) throw unresolved();
  return orderId;
}

export async function getOrderStatus(
  exchange: ExchangeId,
  credentials: RawCredentials,
  pair: string,
  orderId: string,
): Promise<OrderStatusResult> {
  try {
    const entry = await readEntry(
      exchange,
      exchangeApi(exchange, credentials),
      normalizePairForExchange(exchange, pair),
      orderId,
    );
    const status = entry.pending
      ? "pending"
      : entry.filled
        ? "filled"
        : ["Rejected", "rejected", "failed"].includes(entry.state)
          ? "failed"
          : "cancelled";
    return {
      status,
      filledPrice: entry.price || null,
      raw:
        exchange === "bybit"
          ? { result: { list: [entry.row] } }
          : exchange === "okx"
            ? { data: [entry.row] }
            : { data: entry.row },
    };
  } catch (err) {
    throw normalizeError(err);
  }
}

export async function getCurrentPrice(
  exchange: ExchangeId,
  pair: string,
): Promise<CurrentPriceResult> {
  try {
    return await priceFetcher[exchange](pair);
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Cancels an unfilled entry or submits a reduce-only market exit for a live position. */
export async function closeTradeOrder(
  exchange: ExchangeId,
  params: ManualCloseParams,
  request = exchangeApi(exchange, params.credentials),
): Promise<ManualCloseResult> {
  const api = request,
    symbol = normalizePairForExchange(exchange, params.pair);
  let entry = await readEntry(exchange, api, symbol, params.orderId);
  if (entry.pending) {
    await api(
      "POST",
      exchange === "bybit"
        ? "/v5/order/cancel"
        : exchange === "okx"
          ? "/api/v5/trade/cancel-order"
          : "/api/v3/trade/cancel-order",
      exchange === "bybit"
        ? { category: "linear", symbol, orderId: params.orderId }
        : exchange === "okx"
          ? { instId: symbol, ordId: params.orderId }
          : { symbol, category: BITGET_CATEGORY, orderId: params.orderId },
    );
    for (let i = 0; i < 4; i++) {
      entry = await readEntry(exchange, api, symbol, params.orderId);
      if (!entry.pending) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (entry.pending)
      throw new TradeRiskError(
        "ORDER_REVIEW_REQUIRED",
        "Entry cancellation is not yet confirmed. No opposite order was submitted.",
      );
  }
  const live = await position(exchange, api, symbol);
  if (!live) {
    if (entry.filled) {
      const exit = await readConfirmedExit(exchange, api, symbol, entry, params.direction);
      if (exit && !(await position(exchange, api, symbol))) return {
        status: "closed", exitPrice: exit.exitPrice, entryFillPrice: entry.price,
        closedQuantity: new D(exit.orderQuantity).mul(params.sizing?.exchangeInstrumentRules.contractSize ?? "1").toFixed(),
        raw: {},
      };
      throw new TradeRiskError(
        "ORDER_REVIEW_REQUIRED",
        "The position is already flat, but its actual exit price is unavailable. Monitoring must reconcile its exit before profit sharing is recorded.",
      );
    }
    return { status: "cancelled", exitPrice: null, raw: {} };
  }
  const nativeQty = new D(
    exchange === "bybit"
      ? live.size
      : exchange === "okx"
        ? live.pos
        : live.total,
  ).abs();
  const maxQuantity =
    params.sizing?.orderQuantity ??
    (exchange === "okx" ? entry.quantity : params.quantity);
  if (nativeQty.gt(maxQuantity))
    throw new TradeRiskError(
      "POSITION_CHANGED",
      "The exchange position is larger than this trade. No close order was submitted.",
    );
  const nativeSide =
    exchange === "bybit"
      ? live.side
      : exchange === "okx"
        ? new D(live.pos).gt(0)
          ? "Buy"
          : "Sell"
        : live.posSide === "long"
          ? "Buy"
          : "Sell";
  if (nativeSide.toLowerCase() !== params.direction)
    throw new TradeRiskError(
      "POSITION_CHANGED",
      "The exchange position direction changed. No close order was submitted.",
    );
  const side = params.direction === "buy" ? "sell" : "buy";
  const clientId = `scc${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const close =
    exchange === "bybit"
      ? await api("POST", "/v5/order/create", {
          category: "linear",
          symbol,
          side: side === "buy" ? "Buy" : "Sell",
          orderType: "Market",
          qty: nativeQty.toFixed(),
          reduceOnly: true,
          positionIdx: 0,
          orderLinkId: clientId,
        })
      : exchange === "okx"
        ? await api("POST", "/api/v5/trade/order", {
            instId: symbol,
            tdMode: live.mgnMode,
            posSide: "net",
            side,
            ordType: "market",
            sz: nativeQty.toFixed(),
            reduceOnly: true,
            clOrdId: clientId,
          })
        : await api("POST", "/api/v3/trade/place-order", {
            symbol,
            category: BITGET_CATEGORY,
            marginMode: "isolated",
            side,
            orderType: "market",
            qty: nativeQty.toFixed(),
            reduceOnly: "yes",
            clientOid: clientId,
          });
  const id =
    exchange === "bybit"
      ? close.result?.orderId
      : exchange === "okx"
        ? close.data?.[0]?.ordId
        : close.data?.orderId;
  for (let i = 0; i < 5; i++) {
    const exit = await readEntry(
      exchange,
      api,
      symbol,
      String(id || ""),
      clientId,
    );
    if (
      !(await position(exchange, api, symbol)) &&
      exit.filled &&
      new D(exit.price || "0").gt(0)
    )
      return {
        status: "closed",
        exitPrice: exit.price,
        closedQuantity: nativeQty
          .mul(params.sizing?.exchangeInstrumentRules.contractSize ?? "1")
          .toFixed(),
        entryFillPrice: entry.price,
        raw: close,
      };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new TradeRiskError(
    "ORDER_REVIEW_REQUIRED",
    "The reduce-only exit was submitted but its fill is not yet confirmed. No second exit was submitted.",
  );
}

export async function getExchangeBalance(
  exchange: ExchangeId,
  credentials: RawCredentials,
): Promise<ExchangeBalance> {
  try {
    return await balanceFetcher[exchange](credentials);
  } catch (err) {
    const error = normalizeError(err);
    (error as any).exchange = exchange;
    throw error;
  }
}
