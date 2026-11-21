import { randomUUID } from "node:crypto";
import type { ExchangeId, RawCredentials } from "../types/index.js";
import { exchangeApi, type ExchangeRequest } from "./exchangeApiService.js";
import { futuresSymbol } from "./futuresExchangeService.js";
import { D, TradeRiskError, type RiskSnapshot } from "./tradeRiskService.js";
import { Trade } from "../models/tradeModel.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import { decryptCredentials } from "./exchangeConnectionService.js";
import { processTradeClose } from "./profitSharingService.js";

export interface ProtectedOrder {
  credentials: RawCredentials; pair: string; direction: "buy" | "sell";
  orderId: string; clientOrderId: string; quantity: string; orderQuantity: string;
  entryPrice: string; tp: string; sl: string; marginMode: string; sizing?: RiskSnapshot;
}
export class ProtectionFailure extends TradeRiskError {
  constructor(public orderId: string, public recovery: "cancelled" | "closed" | "review", public exitPrice: string | null = null, public closedQuantity?: string, public entryFillPrice?: string) {
    super("STOP_LOSS_PROTECTION_FAILED", recovery === "review"
      ? "Stop-loss protection could not be confirmed and recovery is unresolved. Check your exchange position immediately; this trade needs review."
      : "Stop-loss protection could not be confirmed. The entry was cancelled or the position was closed during recovery.");
  }
}
const same = (a: any, b: string) => { try { return new D(a).eq(b); } catch { return false; } };
export async function readEntry(exchange: ExchangeId, api: ExchangeRequest, symbol: string, id: string, clientId?: string) {
  if (exchange === "bybit") {
    const query = { category: "linear", symbol, ...(id ? { orderId: id } : { orderLinkId: clientId }) };
    const recent = await api("GET", "/v5/order/realtime", query);
    const row = recent.result?.list?.[0] ?? (await api("GET", "/v5/order/history", query)).result?.list?.[0];
    if (!row) throw new TradeRiskError("ORDER_REVIEW_REQUIRED", "The exchange has not returned this order. Keep its client order ID for reconciliation.");
    return { row, state: row.orderStatus, pending: ["New", "PartiallyFilled", "Untriggered"].includes(row.orderStatus), filled: new D(row.cumExecQty || "0").gt(0), quantity: row.qty, price: row.avgPrice };
  }
  if (exchange === "okx") {
    const result = await api("GET", "/api/v5/trade/order", { instId: symbol, ...(id ? { ordId: id } : { clOrdId: clientId }) });
    const row = result.data?.[0];
    if (!row) throw new TradeRiskError("ORDER_REVIEW_REQUIRED", "OKX order details are unavailable.");
    return { row, state: row.state, pending: ["live", "partially_filled"].includes(row.state), filled: new D(row.accFillSz || "0").gt(0), quantity: row.sz, price: row.avgPx };
  }
  const result = await api("GET", "/api/v2/mix/order/detail", { symbol, productType: "USDT-FUTURES", ...(id ? { orderId: id } : { clientOid: clientId }) });
  const row = result.data;
  if (!row) throw new TradeRiskError("ORDER_REVIEW_REQUIRED", "Bitget order details are unavailable.");
  const state = row.state || row.status;
  return { row, state, pending: ["live", "new", "partially_filled", "partial_fill"].includes(state), filled: new D(row.baseVolume || row.filledQty || "0").gt(0) || ["filled", "full_fill"].includes(state), quantity: row.size, price: row.priceAvg };
}
export async function position(exchange: ExchangeId, api: ExchangeRequest, symbol: string) {
  const result = exchange === "bybit" ? await api("GET", "/v5/position/list", { category: "linear", symbol })
    : exchange === "okx" ? await api("GET", "/api/v5/account/positions", { instId: symbol })
    : await api("GET", "/api/v2/mix/position/single-position", { symbol, productType: "USDT-FUTURES", marginCoin: "USDT" });
  const rows = exchange === "bybit" ? result.result?.list : result.data;
  if (!Array.isArray(rows)) throw new Error("Position could not be verified.");
  return rows.find((p: any) => new D(exchange === "bybit" ? p.size : exchange === "okx" ? p.pos : p.total).abs().gt(0));
}
function positionQuantity(exchange: ExchangeId, row: any) { return new D(exchange === "bybit" ? row.size : exchange === "okx" ? row.pos : row.total).abs(); }

/** A flat position alone cannot establish a trade's actual exit price. */
export async function readConfirmedExit(exchange: ExchangeId, api: ExchangeRequest, symbol: string, entry: Awaited<ReturnType<typeof readEntry>>, direction: "buy" | "sell") {
  const opened = Number(entry.row.createdTime ?? entry.row.cTime);
  if (!opened) return null;
  const result = exchange === "bybit" ? await api("GET", "/v5/order/history", { category: "linear", symbol, limit: 50 })
    : exchange === "okx" ? await api("GET", "/api/v5/trade/orders-history", { instType: "SWAP", instId: symbol, state: "filled", limit: 100 })
    : await api("GET", "/api/v2/mix/order/orders-history", { symbol, productType: "USDT-FUTURES", startTime: String(opened), endTime: String(Date.now()), limit: 100 });
  const rows: any[] = exchange === "bybit" ? result.result?.list : exchange === "okx" ? result.data : result.data?.entrustedList;
  if (!Array.isArray(rows)) return null;
  const filledQty = new D(exchange === "bybit" ? entry.row.cumExecQty : exchange === "okx" ? entry.row.accFillSz : entry.row.baseVolume);
  let quantity = new D(0), value = new D(0);
  for (const row of rows) {
    const time = Number(row.createdTime ?? row.cTime);
    const reduce = row.reduceOnly === true || ["true", "YES", "yes"].includes(row.reduceOnly) || row.tradeSide === "close";
    const side = String(row.side || "").toLowerCase();
    const filled = ["Filled", "filled", "full_fill"].includes(row.orderStatus ?? row.state ?? row.status);
    if (!reduce || !filled || time < opened || side !== (direction === "buy" ? "sell" : "buy")) continue;
    const qty = new D(exchange === "bybit" ? row.cumExecQty : exchange === "okx" ? row.accFillSz : row.baseVolume);
    const price = new D(row.avgPrice ?? row.avgPx ?? row.priceAvg);
    if (!qty.gt(0) || !price.gt(0)) continue;
    quantity = quantity.plus(qty); value = value.plus(qty.mul(price));
  }
  return quantity.gt(0) && quantity.eq(filledQty) ? { exitPrice: value.div(quantity).toFixed(), orderQuantity: quantity.toFixed() } : null;
}

export function bitgetProtectionSide(row: any, direction: "buy" | "sell") {
  return [direction === "buy" ? "long" : "short", direction].includes(row.holdSide ?? row.posSide) ||
    (row.posSide === "net" && String(row.side).toLowerCase() === (direction === "buy" ? "sell" : "buy"));
}

export async function hasProtection(exchange: ExchangeId, p: ProtectedOrder, api: ExchangeRequest) {
  const symbol = futuresSymbol(exchange, p.pair), entry = await readEntry(exchange, api, symbol, p.orderId);
  if (!same(entry.quantity, p.orderQuantity) || (!entry.pending && !entry.filled)) return false;
  const live = await position(exchange, api, symbol);
  if (entry.pending && !same(entry.row.price ?? entry.row.px, p.entryPrice)) return false;
  if (live) {
    const long = exchange === "bybit" ? live.side === "Buy" : exchange === "okx" ? new D(live.pos).gt(0) : live.holdSide === "long";
    if (long !== (p.direction === "buy")) return false;
    const liquidation = live.liqPrice ?? live.liqPx ?? live.liquidationPrice;
    if (liquidation && new D(liquidation).gt(0) && (p.direction === "buy" ? new D(liquidation).gte(p.sl) : new D(liquidation).lte(p.sl))) return false;
    if (positionQuantity(exchange, live).gt(p.orderQuantity)) return false;
    const fillPrice = live.avgPrice ?? live.avgPx ?? live.openPriceAvg;
    if (p.sizing && fillPrice) {
      const base = positionQuantity(exchange, live).mul(p.sizing.exchangeInstrumentRules.contractSize);
      const risk = new D(fillPrice).minus(p.sl).abs().mul(base).plus(new D(fillPrice).plus(p.sl).mul(base).mul(p.sizing.takerFeeRate));
      if (risk.gt(p.sizing.riskAmount)) return false;
    }
  }
  if (!live && entry.filled) return false; // A missing position is not proof of the exit price.
  if (exchange === "bybit") {
    const levels = live ?? entry.row;
    return same(levels.stopLoss, p.sl) && same(levels.takeProfit, p.tp) &&
      (!live ? entry.row.tpslMode === "Full" && !new D(entry.row.slLimitPrice || "0").gt(0) && entry.row.slTriggerBy === "MarkPrice" : true);
  }
  if (exchange === "okx") {
    if (!live) return entry.row.attachAlgoOrds?.some((r: any) => same(r.slTriggerPx, p.sl) && same(r.tpTriggerPx, p.tp) && r.slOrdPx === "-1") === true;
    for (const ordType of ["conditional", "oco"]) {
      const orders = await api("GET", "/api/v5/trade/orders-algo-pending", { instId: symbol, ordType });
      if (orders.data?.some((r: any) => same(r.slTriggerPx, p.sl) && same(r.tpTriggerPx, p.tp) && r.slOrdPx === "-1" &&
          new D(r.sz || "0").gte(positionQuantity(exchange, live)) && r.side === (p.direction === "buy" ? "sell" : "buy"))) return true;
    }
    return false;
  }
  if (!live) return same(entry.row.presetStopLossPrice, p.sl) && same(entry.row.presetStopSurplusPrice, p.tp) && new D(entry.row.presetStopLossExecutePrice || "0").eq(0);
  const orders = await api("GET", "/api/v2/mix/order/orders-plan-pending", { symbol, productType: "USDT-FUTURES", planType: "profit_loss" });
  const rows = orders.data?.entrustedList;
  if (!Array.isArray(rows)) return false;
  const match = (r: any, price: string, types: string[]) => types.includes(r.planType) && same(r.triggerPrice, price) &&
    bitgetProtectionSide(r, p.direction) && new D(r.executePrice || "0").eq(0) && (["pos_loss", "pos_profit"].includes(r.planType) || new D(r.size || "0").gte(positionQuantity(exchange, live)));
  return rows.some(r => match(r, p.sl, ["loss_plan", "pos_loss"])) && rows.some(r => match(r, p.tp, ["profit_plan", "pos_profit"]));
}

export async function repairProtection(exchange: ExchangeId, p: ProtectedOrder, api: ExchangeRequest) {
  const symbol = futuresSymbol(exchange, p.pair), live = await position(exchange, api, symbol);
  if (exchange === "bybit") {
    await api("POST", live ? "/v5/position/trading-stop" : "/v5/order/amend", {
      category: "linear", symbol, ...(live ? { positionIdx: 0 } : { orderId: p.orderId }),
      takeProfit: p.tp, stopLoss: p.sl, tpslMode: "Full", tpOrderType: "Market", slOrderType: "Market", tpTriggerBy: "MarkPrice", slTriggerBy: "MarkPrice",
    });
  } else if (exchange === "okx") {
    if (!live) throw new Error("Pending OKX protection was not accepted.");
    await api("POST", "/api/v5/trade/order-algo", { instId: symbol, tdMode: p.marginMode, side: p.direction === "buy" ? "sell" : "buy", posSide: "net",
      ordType: "oco", sz: positionQuantity(exchange, live).toFixed(), reduceOnly: true, algoClOrdId: `${p.clientOrderId}r`.slice(0, 32),
      tpTriggerPx: p.tp, tpOrdPx: "-1", slTriggerPx: p.sl, slOrdPx: "-1", tpTriggerPxType: "mark", slTriggerPxType: "mark" });
  } else if (live) {
    await api("POST", "/api/v2/mix/order/place-pos-tpsl", { symbol, productType: "USDT-FUTURES", marginCoin: "USDT", holdSide: p.direction,
      stopLossTriggerPrice: p.sl, stopLossTriggerType: "mark_price", stopLossExecutePrice: "0",
      stopSurplusTriggerPrice: p.tp, stopSurplusTriggerType: "mark_price", stopSurplusExecutePrice: "0" });
  } else {
    await api("POST", "/api/v2/mix/order/modify-order", { symbol, productType: "USDT-FUTURES", orderId: p.orderId, newClientOid: `${p.clientOrderId}r`.slice(0, 32), newPresetStopLossPrice: p.sl, newPresetStopSurplusPrice: p.tp });
  }
}

async function recoverUnprotected(exchange: ExchangeId, p: ProtectedOrder, api: ExchangeRequest): Promise<ProtectionFailure> {
  const symbol = futuresSymbol(exchange, p.pair);
  try {
    let entry = await readEntry(exchange, api, symbol, p.orderId);
    if (entry.pending) {
      const path = exchange === "bybit" ? "/v5/order/cancel" : exchange === "okx" ? "/api/v5/trade/cancel-order" : "/api/v2/mix/order/cancel-order";
      await api("POST", path, exchange === "bybit" ? { category: "linear", symbol, orderId: p.orderId } : exchange === "okx" ? { instId: symbol, ordId: p.orderId } : { symbol, productType: "USDT-FUTURES", orderId: p.orderId });
      entry = await readEntry(exchange, api, symbol, p.orderId);
      if (entry.pending) return new ProtectionFailure(p.orderId, "review");
    }
    const live = await position(exchange, api, symbol);
    if (!live) return new ProtectionFailure(p.orderId, entry.filled ? "review" : "cancelled");
    const qty = D.min(positionQuantity(exchange, live), p.orderQuantity).toFixed();
    const side = p.direction === "buy" ? "sell" : "buy";
    const clientId = `scr${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const close = exchange === "bybit"
      ? await api("POST", "/v5/order/create", { category: "linear", symbol, side: side === "buy" ? "Buy" : "Sell", orderType: "Market", qty, positionIdx: 0, reduceOnly: true, orderLinkId: clientId })
      : exchange === "okx"
        ? await api("POST", "/api/v5/trade/order", { instId: symbol, tdMode: p.marginMode, side, posSide: "net", ordType: "market", sz: qty, reduceOnly: true, clOrdId: clientId })
        : await api("POST", "/api/v2/mix/order/place-order", { symbol, productType: "USDT-FUTURES", marginCoin: "USDT", marginMode: p.marginMode, side, orderType: "market", size: qty, reduceOnly: "YES", clientOid: clientId });
    const id = exchange === "bybit" ? close.result?.orderId : exchange === "okx" ? close.data?.[0]?.ordId : close.data?.orderId;
    for (let attempt = 0; attempt < 3; attempt++) {
      const exit = await readEntry(exchange, api, symbol, String(id || ""), clientId);
      if (!(await position(exchange, api, symbol)) && exit.filled && new D(exit.price || "0").gt(0)) return new ProtectionFailure(p.orderId, "closed", exit.price,
        new D(qty).mul(p.sizing?.exchangeInstrumentRules.contractSize ?? "1").toFixed(), entry.price);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  } catch { /* A timeout never authorizes another entry or an opposite non-reduce-only order. */ }
  return new ProtectionFailure(p.orderId, "review");
}

export async function verifyOrRecoverProtection(exchange: ExchangeId, p: ProtectedOrder, api = exchangeApi(exchange, p.credentials)) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { if (await hasProtection(exchange, p, api)) return; } catch { /* Retry read-back before any recovery. */ }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 200));
  }
  try {
    await repairProtection(exchange, p, api);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await hasProtection(exchange, p, api)) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  } catch { /* Recovery below cancels the remaining entry before reducing exposure. */ }
  throw await recoverUnprotected(exchange, p, api);
}

const checks = new Map<string, Promise<boolean>>();
/** Called after fills and during restart reconciliation. No entry is ever resubmitted. */
export function enforceStoredTradeProtection(id: string): Promise<boolean> {
  const current = checks.get(id);
  if (current) return current;
  const work = (async () => {
    const trade = await Trade.findOne({ _id: id, status: { $in: ["pending", "filled"] } });
    if (!trade) return false;
    const connection = await ExchangeConnection.findById(trade.exchangeConnectionId).lean();
    if (!connection?.encryptedApiKey || !connection.encryptedApiSecret) return false;
    const exchange = connection.exchange as ExchangeId;
    const credentials = decryptCredentials({ exchange, apiKey: connection.encryptedApiKey, apiSecret: connection.encryptedApiSecret,
      ...(connection.encryptedPassphrase ? { passphrase: connection.encryptedPassphrase } : {}) });
    const api = exchangeApi(exchange, credentials), symbol = futuresSymbol(exchange, trade.pair);
    try {
      const entry = await readEntry(exchange, api, symbol, trade.exchangeOrderId || "", trade.exchangeClientOrderId || undefined);
      const orderId = String(exchange === "bybit" ? entry.row.orderId : exchange === "okx" ? entry.row.ordId : entry.row.orderId);
      if (!orderId || orderId === "undefined") throw new Error("Order ID unavailable.");
      trade.exchangeOrderId = orderId;
      if (entry.filled && new D(entry.price || "0").gt(0)) trade.entryFillPrice = entry.price;
      await trade.save();
      const sizing = trade.sizing as RiskSnapshot | null;
      let quantity = sizing?.orderQuantity ?? trade.quantity;
      if (!sizing && exchange === "okx") {
        const instrument = (await api("GET", "/api/v5/public/instruments", { instType: "SWAP", instId: symbol })).data?.[0];
        quantity = new D(trade.quantity).div(new D(instrument.ctVal).mul(instrument.ctMult)).toFixed();
      }
      const live = await position(exchange, api, symbol);
      if (!entry.pending && !entry.filled && !live) {
        await Trade.updateOne({ _id: id, status: { $in: ["pending", "filled"] } }, { $set: { status: "cancelled", closedAt: new Date() } });
        return false;
      }
      if (entry.filled && !live) {
        if (entry.pending) {
          await api("POST", exchange === "bybit" ? "/v5/order/cancel" : exchange === "okx" ? "/api/v5/trade/cancel-order" : "/api/v2/mix/order/cancel-order",
            exchange === "bybit" ? { category: "linear", symbol, orderId } : exchange === "okx" ? { instId: symbol, ordId: orderId } : { symbol, productType: "USDT-FUTURES", orderId });
          if ((await readEntry(exchange, api, symbol, orderId)).pending) throw new Error("Remaining entry cancellation is unconfirmed.");
        }
        const exit = await readConfirmedExit(exchange, api, symbol, entry, trade.direction as "buy" | "sell");
        if (!exit || await position(exchange, api, symbol)) throw new Error("Actual exit could not be reconciled.");
        const multiplier = sizing?.exchangeInstrumentRules.contractSize ?? (exchange === "okx" ? new D(trade.quantity).div(quantity).toFixed() : "1");
        await Trade.updateOne({ _id: id }, { $set: { quantity: new D(exit.orderQuantity).mul(multiplier).toFixed(), ...(entry.price ? { entryFillPrice: entry.price } : {}) } });
        await processTradeClose(id, exit.exitPrice, "manual");
        return false;
      }
      await verifyOrRecoverProtection(exchange, { credentials, pair: trade.pair, direction: trade.direction as "buy" | "sell",
        orderId, clientOrderId: trade.exchangeClientOrderId || `sc${String(trade._id)}`, quantity: trade.quantity, orderQuantity: quantity,
        entryPrice: trade.entryPrice, sl: trade.sl, tp: trade.tp, marginMode: trade.marginMode || (exchange === "okx" ? "isolated" : "crossed"),
        ...(sizing ? { sizing } : {}) }, api);
      await Trade.updateOne({ _id: id, status: { $in: ["pending", "filled"] } }, { $set: {
        ...(entry.filled && !entry.pending ? { status: "filled" } : {}),
        protectionStatus: "confirmed", protectionCheckedAt: new Date(), protectionError: null,
        ...(sizing && trade.entryFillPrice ? { "sizing.acceptedEntryPrice": trade.entryFillPrice,
          "sizing.estimatedRiskAtFill": new D(trade.entryFillPrice).minus(trade.sl).abs().mul(trade.quantity)
            .plus(new D(trade.entryFillPrice).plus(trade.sl).mul(trade.quantity).mul(sizing.takerFeeRate)).toFixed() } : {}),
      } });
      return true;
    } catch (error) {
      const failure = error instanceof ProtectionFailure ? error : null;
      await Trade.updateOne({ _id: id, status: { $in: ["pending", "filled"] } }, { $set: {
        protectionStatus: failure && failure.recovery !== "review" ? "failed" : "review",
        protectionError: failure?.message ?? "Exchange protection could not be verified; review required.",
        ...(failure?.recovery === "cancelled" ? { status: "cancelled" } : {}),
        ...(failure?.closedQuantity ? { quantity: failure.closedQuantity } : {}),
        ...(failure?.entryFillPrice ? { entryFillPrice: failure.entryFillPrice } : {}),
      } });
      if (failure?.recovery === "closed" && failure.exitPrice) await processTradeClose(id, failure.exitPrice, "manual");
      return false;
    }
  })().finally(() => checks.delete(id));
  checks.set(id, work);
  return work;
}

export async function recordProtectionFailure(id: string, failure: ProtectionFailure) {
  await Trade.updateOne({ _id: id, status: { $in: ["pending", "filled"] } }, { $set: {
    protectionStatus: failure.recovery === "review" ? "review" : "failed", protectionError: failure.message,
    ...(failure.recovery === "cancelled" ? { status: "cancelled", closedAt: new Date() } : {}),
    ...(failure.closedQuantity ? { quantity: failure.closedQuantity } : {}),
    ...(failure.entryFillPrice ? { entryFillPrice: failure.entryFillPrice } : {}),
  } });
  if (failure.recovery === "closed" && failure.exitPrice) await processTradeClose(id, failure.exitPrice, "manual");
}
