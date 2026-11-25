import { Decimal } from "decimal.js";
import { MAX_RISK_PERCENT } from "../constants.js";

export const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_DOWN });
export class TradeRiskError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export interface MarginTier {
  maximumNotional?: string;
  maximumOrderQuantity?: string;
  minimumOrderQuantity?: string;
  maximumLeverage: string;
  maintenanceRate: string;
  initialMarginRate?: string;
  maintenanceDeduction?: string;
  minimumNotional?: string;
}
export interface InstrumentRules {
  symbol: string;
  quantityStep: string; // Exchange units; OKX uses contracts.
  minimumQuantity: string;
  maximumQuantity: string;
  minimumNotional: string;
  maximumNotional?: string;
  priceTickSize: string;
  contractSize: string; // Base-asset units in one exchange quantity unit.
  minimumLeverage: string;
  maximumLeverage: string;
  leverageStep: string;
  openingMarginBufferRate?: string;
  tiers: MarginTier[];
}
export function decimal(value: Decimal.Value, name: string, allowZero = false) {
  let number: Decimal;
  try { number = new D(value); } catch { throw new TradeRiskError("INVALID_EXCHANGE_RULES", `${name} is unavailable or invalid.`); }
  if (!number.isFinite() || (allowZero ? number.lt(0) : number.lte(0))) throw new TradeRiskError("INVALID_EXCHANGE_RULES", `${name} is unavailable or invalid.`);
  return number;
}
export function floorStep(value: Decimal.Value, step: string) { return new D(value).div(decimal(step, "Quantity step")).floor().mul(step).toFixed(); }
function tick(value: string, step: string, up: boolean) {
  const units = decimal(value, "Price").div(decimal(step, "Price tick"));
  return (up ? units.ceil() : units.floor()).mul(step).toFixed();
}

export function calculateTradeRisk(input: {
  exchange: string; availableBalance: string; accountBalance: string; entry: string; sl: string; tp: string;
  direction: "buy" | "sell"; takerFeeRate: string; rules: InstrumentRules;
  marginMode: string;
}) {
  const { rules, direction } = input;
  if (direction !== "buy" && direction !== "sell") throw new TradeRiskError("INVALID_DIRECTION", "Choose buy or sell.");
  const available = decimal(input.availableBalance, "Available futures balance");
  decimal(input.accountBalance, "Account equity", true);
  const entryPrice = tick(input.entry, rules.priceTickSize, direction === "sell");
  const stopLossPrice = tick(input.sl, rules.priceTickSize, direction === "buy");
  const takeProfitPrice = tick(input.tp, rules.priceTickSize, direction === "sell");
  const entry = new D(entryPrice), stop = new D(stopLossPrice), take = new D(takeProfitPrice);
  if (!(direction === "buy" ? stop.lt(entry) && take.gt(entry) : take.lt(entry) && stop.gt(entry))) {
    throw new TradeRiskError("INVALID_STOP_LOSS", "Prices must put the stop loss below a long entry or above a short entry, with take profit on the opposite side.");
  }
  const feeRate = decimal(input.takerFeeRate, "Trading fee rate", true);
  if (feeRate.gte(1)) throw new TradeRiskError("INVALID_EXCHANGE_RULES", "Trading fee rate is invalid.");
  const riskAmount = available.mul(MAX_RISK_PERCENT);
  const distance = entry.minus(stop).abs();
  const theoreticalQuantity = riskAmount.div(distance);
  // Both entry and stop exits may execute as taker orders. Fees use the stop's price.
  const baseQuantity = riskAmount.div(distance.plus(entry.plus(stop).mul(feeRate)));
  const multiplier = decimal(rules.contractSize, "Contract size");
  const orderQuantity = floorStep(baseQuantity.div(multiplier), rules.quantityStep);
  const quantity = new D(orderQuantity).mul(multiplier);
  const notional = quantity.mul(entry);
  if (new D(orderQuantity).lt(decimal(rules.minimumQuantity, "Minimum quantity")) || quantity.lte(0)) {
    throw new TradeRiskError("MINIMUM_QUANTITY", "The exchange minimum quantity would exceed your 2% risk allowance, including fees. Use a signal with a smaller stop distance or a larger available balance.");
  }
  if (notional.lt(decimal(rules.minimumNotional, "Minimum notional", true))) throw new TradeRiskError("MINIMUM_NOTIONAL", "The position permitted by your 2% risk allowance is below the exchange minimum order value.");
  if (new D(orderQuantity).gt(decimal(rules.maximumQuantity, "Maximum quantity")) || (rules.maximumNotional && notional.gt(decimal(rules.maximumNotional, "Maximum notional")))) throw new TradeRiskError("POSITION_LIMIT", "The calculated position exceeds the exchange's order or position limit.");
  const tiers = [...rules.tiers].sort((a, b) => new D(a.maximumOrderQuantity ?? a.maximumNotional ?? "0").cmp(b.maximumOrderQuantity ?? b.maximumNotional ?? "0"));
  const tier = tiers.find(item => item.maximumOrderQuantity
    ? new D(orderQuantity).lte(decimal(item.maximumOrderQuantity, "Tier contract limit"))
    : notional.lte(decimal(item.maximumNotional!, "Tier notional limit")));
  if (!tier) throw new TradeRiskError("POSITION_LIMIT", "No permitted margin tier covers this position.");
  const maintenance = notional.mul(decimal(tier.maintenanceRate, "Maintenance margin rate", true));
  const openingFee = notional.mul(feeRate), closingFee = quantity.mul(stop).mul(feeRate);
  const stopLoss = quantity.mul(distance);
  const estimatedRisk = stopLoss.plus(openingFee).plus(closingFee);
  if (estimatedRisk.gt(riskAmount)) throw new TradeRiskError("RISK_LIMIT", "The final quantity and fees exceed your 2% risk allowance.");
  const marginReserve = available.mul("0.05").plus(maintenance).plus(openingFee).plus(closingFee);
  const usableMargin = available.minus(marginReserve);
  if (usableMargin.lte(0)) throw new TradeRiskError("INSUFFICIENT_MARGIN", "Insufficient available margin after trading fees and maintenance reserve.");
  const step = decimal(rules.leverageStep, "Leverage step");
  const minimum = decimal(rules.minimumLeverage, "Minimum leverage");
  const maximum = D.min(decimal(rules.maximumLeverage, "Maximum leverage"), decimal(tier.maximumLeverage, "Tier leverage"));
  const openingBufferRate = decimal(rules.openingMarginBufferRate ?? "0", "Opening margin buffer", true);
  const leverage = D.max(minimum, notional.mul(openingBufferRate.plus(1)).div(usableMargin)).minus(minimum).div(step).ceil().mul(step).plus(minimum);
  const initialMargin = D.max(notional.div(leverage), notional.mul(decimal(tier.initialMarginRate ?? "0", "Initial margin rate", true)));
  const totalReserve = marginReserve.plus(initialMargin.mul(openingBufferRate));
  if (leverage.gt(maximum) || initialMargin.plus(totalReserve).gt(available)) {
    throw new TradeRiskError("INSUFFICIENT_MARGIN", "Insufficient available margin for this trade at permitted leverage after fees and maintenance reserves.");
  }
  const liquidation = validateLiquidationSafety({ exchange: input.exchange, marginMode: input.marginMode,
    direction, entry: entryPrice, stop: stopLossPrice, quantity: quantity.toFixed(),
    orderQuantity, initialMargin: initialMargin.toFixed(), takerFeeRate: feeRate.toFixed(), rules });
  return {
    ...liquidation, marginMode: input.marginMode,
    accountBalance: input.accountBalance, availableBalance: available.toFixed(), riskPercent: MAX_RISK_PERCENT,
    riskAmount: riskAmount.toFixed(), theoreticalQuantityBeforeFees: theoreticalQuantity.toFixed(),
    estimatedRiskAmount: estimatedRisk.toFixed(), estimatedOpeningFee: openingFee.toFixed(), estimatedClosingFee: closingFee.toFixed(),
    positionQuantity: quantity.toFixed(), orderQuantity, positionNotional: notional.toFixed(), leverage: leverage.toNumber(),
    initialMargin: initialMargin.toFixed(), maintenanceMargin: maintenance.toFixed(), marginReserve: totalReserve.toFixed(),
    entryPrice, stopLossPrice, takeProfitPrice, priceDistance: distance.toFixed(), exchange: input.exchange,
    takerFeeRate: feeRate.toFixed(), marginTier: tier, exchangeInstrumentRules: rules,
  };
}
export type RiskSnapshot = ReturnType<typeof calculateTradeRisk>;

/** Isolated, new one-way linear positions only. Official formulas and limits are
 * documented in docs/futures-risk-management-final-audit.md. Never infer cross
 * account safety from the collateral allocated to a single order. */
export function validateLiquidationSafety(input: {
  exchange: string; marginMode: string; direction: "buy" | "sell";
  entry: string; stop: string; quantity: string; orderQuantity: string;
  initialMargin: string; takerFeeRate: string; rules: InstrumentRules;
}) {
  if (input.marginMode !== "isolated") throw new TradeRiskError("UNSUPPORTED_MARGIN_MODE",
    `${input.exchange}: liquidation safety requires isolated margin. Cross and portfolio account-wide liquidation cannot be verified by this planner.`);
  if (!["bybit", "okx", "bitget"].includes(input.exchange)) throw new TradeRiskError("UNSUPPORTED_EXCHANGE", "No verified liquidation model exists for this exchange.");
  const e = decimal(input.entry, "Liquidation entry"), q = decimal(input.quantity, "Liquidation quantity");
  const m = decimal(input.initialMargin, "Liquidation initial margin"), f = decimal(input.takerFeeRate, "Liquidation fee", true);
  const sign = input.direction === "buy" ? new D(1) : new D(-1);
  const stop = decimal(input.stop, "Liquidation stop");
  const buffer = decimal(process.env.LIQUIDATION_SAFETY_BUFFER_RATE ?? "0.1", "Liquidation safety buffer");
  if (buffer.gte(1)) throw new TradeRiskError("INVALID_EXCHANGE_RULES", "Liquidation safety buffer must be greater than zero and less than one.");
  // Deduct both trading fees from collateral as an additional conservative reserve.
  // Bybit's bankruptcy closing-fee terms cancel in its published no-extra-margin formula.
  const collateral = m.minus(q.mul(e.plus(stop)).mul(f));
  const candidates: Decimal[] = [];
  const tiers = [...input.rules.tiers].sort((a, b) => new D(a.maximumOrderQuantity ?? a.maximumNotional!).cmp(b.maximumOrderQuantity ?? b.maximumNotional!));
  let lower = new D(0);
  for (const tier of tiers) {
    const rate = decimal(tier.maintenanceRate, "Liquidation maintenance rate", true);
    if (rate.plus(f).gte(1)) throw new TradeRiskError("INVALID_EXCHANGE_RULES", "Liquidation maintenance and fee rates are invalid.");
    const upper = decimal(tier.maximumOrderQuantity ?? tier.maximumNotional!, "Liquidation tier limit");
    let deduction = new D(0);
    if (input.exchange === "bybit") deduction = decimal(tier.maintenanceDeduction!, "Bybit maintenance deduction", true);
    if (input.exchange === "bitget") {
      // UTA v3 tiers do not expose MM deductions. Only the verified first
      // tier (starting at zero, zero deduction) is supported; never guess higher tiers.
      if (!lower.isZero() || tier.minimumNotional !== "0" || q.mul(e).gt(upper)) break;
    }
    const effectiveRate = input.exchange === "bybit" ? rate : rate.plus(f);
    const boundary = q.mul(e).minus(sign.mul(collateral.plus(deduction)))
      .div(q.mul(new D(1).minus(sign.mul(effectiveRate))));
    const tierValue = tier.maximumOrderQuantity ? new D(input.orderQuantity) : q.mul(D.max(0, boundary));
    const minimum = tier.minimumOrderQuantity ?? tier.minimumNotional;
    const tierLower = minimum === undefined ? lower : decimal(minimum, "Liquidation tier minimum", true);
    if (tierValue.gte(tierLower) && tierValue.lte(upper)) candidates.push(D.max(0, boundary));
    lower = upper;
  }
  if (!candidates.length) throw new TradeRiskError("LIQUIDATION_UNVERIFIABLE", `${input.exchange}: no verified maintenance tier covers the estimated liquidation boundary (Bitget UTA supports the first tier only).`);
  const boundary = input.direction === "buy" ? D.max(...candidates) : D.min(...candidates);
  const clearance = stop.minus(boundary).mul(sign);
  const required = D.max(e.minus(stop).abs().mul(buffer), decimal(input.rules.priceTickSize, "Liquidation price tick"));
  if (collateral.lte(0) || clearance.lte(required)) throw new TradeRiskError("UNSAFE_LIQUIDATION", `${input.exchange}: stop loss is too close to or beyond the estimated liquidation boundary, including the safety buffer.`);
  return { estimatedLiquidationPrice: boundary.toFixed(), liquidationSafetyBufferRate: buffer.toFixed(),
    liquidationClearance: clearance.toFixed(), liquidationModel: `${input.exchange}-isolated-linear`, liquidationFeeReserve: q.mul(e.plus(stop)).mul(f).toFixed() };
}

/** An amendment cannot expand the original cash-risk or reserved margin budget. */
export function validateAmendmentRisk(trade: any, entry: string, tp: string, sl: string): RiskSnapshot {
  const previous = trade.sizing as RiskSnapshot | null;
  if (!previous) throw new TradeRiskError("RISK_SNAPSHOT_REQUIRED", "This trade has no risk snapshot. Its prices cannot be safely amended; it can still be closed.");
  const plan = { entryPrice: tick(entry, previous.exchangeInstrumentRules.priceTickSize, trade.direction === "sell"),
    stopLossPrice: tick(sl, previous.exchangeInstrumentRules.priceTickSize, trade.direction === "buy"),
    takeProfitPrice: tick(tp, previous.exchangeInstrumentRules.priceTickSize, trade.direction === "sell") };
  const valid = trade.direction === "buy" ? new D(plan.stopLossPrice).lt(plan.entryPrice) && new D(plan.takeProfitPrice).gt(plan.entryPrice)
    : new D(plan.stopLossPrice).gt(plan.entryPrice) && new D(plan.takeProfitPrice).lt(plan.entryPrice);
  if (!valid) throw new TradeRiskError("INVALID_STOP_LOSS", "Amended stop loss, entry and take profit must remain valid for the trade direction.");
  const qty = decimal(trade.quantity, "Position quantity"), fill = new D(plan.entryPrice);
  const risk = fill.minus(plan.stopLossPrice).abs().mul(qty).plus(fill.plus(plan.stopLossPrice).mul(qty).mul(previous.takerFeeRate));
  const margin = fill.mul(qty).div(trade.leverage || previous.leverage);
  if (risk.gt(previous.riskAmount) || margin.gt(previous.initialMargin)) throw new TradeRiskError("AMENDMENT_RISK_LIMIT", "This amendment would exceed the trade's original 2% risk or margin budget. Tighten the stop loss or close the trade instead.");
  const liquidation = validateLiquidationSafety({ exchange: previous.exchange, marginMode: previous.marginMode,
    direction: trade.direction, entry: plan.entryPrice, stop: plan.stopLossPrice, quantity: qty.toFixed(), orderQuantity: previous.orderQuantity,
    initialMargin: margin.toFixed(), takerFeeRate: previous.takerFeeRate, rules: previous.exchangeInstrumentRules });
  return { ...previous, ...liquidation, entryPrice: plan.entryPrice, takeProfitPrice: plan.takeProfitPrice, stopLossPrice: plan.stopLossPrice,
    estimatedRiskAmount: risk.toFixed(), estimatedOpeningFee: fill.mul(qty).mul(previous.takerFeeRate).toFixed(), estimatedClosingFee: new D(plan.stopLossPrice).mul(qty).mul(previous.takerFeeRate).toFixed(),
    priceDistance: fill.minus(plan.stopLossPrice).abs().toFixed(), initialMargin: margin.toFixed(), positionNotional: fill.mul(qty).toFixed() };
}
