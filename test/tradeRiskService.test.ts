import test from "node:test";
import assert from "node:assert/strict";
import { calculateTradeRisk, validateAmendmentRisk, D, type InstrumentRules } from "../src/services/tradeRiskService.js";

export const btcRules: InstrumentRules = { symbol: "BTCUSDT", quantityStep: "0.001", minimumQuantity: "0.001", maximumQuantity: "100",
  minimumNotional: "5", priceTickSize: "0.1", contractSize: "1", minimumLeverage: "1", maximumLeverage: "100", leverageStep: "1",
  tiers: [{ maximumNotional: "100000", maximumLeverage: "100", maintenanceRate: "0.005", initialMarginRate: "0.01" }] };
const sample = { exchange: "bybit", availableBalance: "50", accountBalance: "50", entry: "64755.1", sl: "64949.3", tp: "64000", direction: "sell" as const, takerFeeRate: "0.0006", rules: btcRules };

for (const balance of ["50", "100", "250", "500", "1000"]) test(`$${balance}: stop loss plus both fees stays within 2%`, () => {
  const result = calculateTradeRisk({ ...sample, availableBalance: balance, accountBalance: balance });
  const expectedRisk = new D(balance).mul("0.02");
  assert.equal(result.riskAmount, expectedRisk.toFixed());
  assert(new D(result.theoreticalQuantityBeforeFees).mul("194.2").minus(expectedRisk).abs().lt("1e-40"));
  assert(new D(result.estimatedRiskAmount).lte(expectedRisk));
  assert(new D(result.positionQuantity).lte(result.theoreticalQuantityBeforeFees));
  assert(new D(result.orderQuantity).mod(btcRules.quantityStep).isZero());
  assert(new D(result.initialMargin).plus(result.marginReserve).lte(balance));
  if (result.leverage > 1) assert(new D(result.positionNotional).div(result.leverage - 1).plus(result.marginReserve).gt(balance));
});

test("long and short tick rounding keeps a valid stop and recalculates risk", () => {
  const long = calculateTradeRisk({ ...sample, direction: "buy", sl: "64560.87", tp: "65000.09" });
  assert.equal(long.stopLossPrice, "64560.9");
  assert(new D(long.estimatedRiskAmount).lte(1));
  assert.throws(() => calculateTradeRisk({ ...sample, direction: "buy" }), /stop loss/);
  assert.throws(() => calculateTradeRisk({ ...sample, sl: "64755.11" }), /stop loss/);
});

test("exchange minimum quantity and minimum notional never round risk upward", () => {
  assert.throws(() => calculateTradeRisk({ ...sample, rules: { ...btcRules, minimumQuantity: "0.01" } }), /minimum quantity.*2%/);
  assert.throws(() => calculateTradeRisk({ ...sample, rules: { ...btcRules, minimumNotional: "500" } }), /minimum order value/);
  assert.throws(() => calculateTradeRisk({ ...sample, rules: { ...btcRules, maximumQuantity: "0.001" } }), /position limit/);
});

test("insufficient leverage, missing balance or tier information rejects before entry", () => {
  assert.throws(() => calculateTradeRisk({ ...sample, rules: { ...btcRules, maximumLeverage: "2" } }), /permitted leverage/);
  assert.throws(() => calculateTradeRisk({ ...sample, rules: { ...btcRules, tiers: [] } }), /margin tier/);
  assert.throws(() => calculateTradeRisk({ ...sample, availableBalance: "" }), /unavailable/);
  assert.throws(() => calculateTradeRisk({ ...sample, availableBalance: "NaN" }), /unavailable/);
});

test("OKX quantities are contracts while risk and profit quantities stay in base units", () => {
  const result = calculateTradeRisk({ ...sample, exchange: "okx", rules: { ...btcRules, symbol: "BTC-USDT-SWAP", contractSize: "0.01", quantityStep: "0.01", minimumQuantity: "0.01",
    tiers: [{ maximumOrderQuantity: "10000", maximumLeverage: "100", maintenanceRate: "0.005" }] } });
  assert(new D(result.orderQuantity).mul("0.01").eq(result.positionQuantity));
  assert(new D(result.estimatedRiskAmount).lte(1));
});

test("different copiers independently size from their own available balance", () => {
  const pro = calculateTradeRisk({ ...sample, availableBalance: "1000", accountBalance: "1000" });
  const copier = calculateTradeRisk(sample);
  assert(new D(copier.positionQuantity).lt(pro.positionQuantity));
  assert.equal(copier.riskAmount, "1");
  assert.equal(pro.riskAmount, "20");
});

test("amendments retain actual quantity and cannot widen cash risk beyond the original budget", () => {
  const sizing = calculateTradeRisk(sample);
  const trade = { direction: "sell", quantity: sizing.positionQuantity, leverage: sizing.leverage, sizing };
  const tightened = validateAmendmentRisk(trade, sample.entry, sample.tp, "64800");
  assert.equal(tightened.orderQuantity, sizing.orderQuantity);
  assert.ok(new D(tightened.estimatedRiskAmount).lt(sizing.estimatedRiskAmount));
  assert.throws(() => validateAmendmentRisk(trade, sample.entry, sample.tp, "66000"), /original 2% risk/);
});
