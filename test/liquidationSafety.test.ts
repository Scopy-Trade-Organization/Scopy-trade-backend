import test from "node:test";
import assert from "node:assert/strict";
import { D, validateLiquidationSafety, type InstrumentRules } from "../src/services/tradeRiskService.js";

const rules: InstrumentRules = { symbol: "BTCUSDT", quantityStep: "0.001", minimumQuantity: "0.001", maximumQuantity: "100",
  minimumNotional: "5", priceTickSize: "0.1", contractSize: "1", minimumLeverage: "1", maximumLeverage: "100", leverageStep: "1",
  tiers: [{ minimumNotional: "0", maximumNotional: "1000000", maximumLeverage: "100", maintenanceRate: "0.005", maintenanceDeduction: "0" }] };
const sample = { exchange: "bybit", marginMode: "isolated", direction: "buy" as "buy" | "sell", entry: "60000", stop: "59000",
  quantity: "0.01", orderQuantity: "0.01", initialMargin: "60", takerFeeRate: "0.0006", rules };

for (const exchange of ["bybit", "okx", "bitget"]) {
  for (const direction of ["buy", "sell"] as const) {
    test(`${exchange} ${direction}: documented isolated formula with fee reserve and stop clearance`, () => {
      const stop = direction === "buy" ? "59000" : "61000";
      const result = validateLiquidationSafety({ ...sample, exchange, direction, stop });
      const feeReserve = new D("0.01").mul(new D(60000).plus(stop)).mul("0.0006");
      const collateral = new D(60).minus(feeReserve);
      const rate = exchange === "bybit" ? "0.005" : "0.0056";
      const expected = direction === "buy" ? new D(600).minus(collateral).div(new D("0.01").mul(new D(1).minus(rate)))
        : new D(600).plus(collateral).div(new D("0.01").mul(new D(1).plus(rate)));
      assert.ok(new D(result.estimatedLiquidationPrice).minus(expected).abs().lt("1e-35"));
      assert.equal(result.liquidationModel, `${exchange}-isolated-linear`);
      assert.ok(new D(result.liquidationClearance).gt(100));
      assert.equal(result.liquidationFeeReserve, feeReserve.toFixed());
    });
    test(`${exchange} ${direction}: liquidation at or ahead of stop is rejected`, () => {
      assert.throws(() => validateLiquidationSafety({ ...sample, exchange, direction, stop: direction === "buy" ? "59000" : "61000", initialMargin: "10" }), /stop loss.*liquidation/);
    });
  }
  test(`${exchange}: cross, portfolio and missing margin mode are never assumed safe`, () => {
    for (const marginMode of ["cross", "crossed", "portfolio", ""]) assert.throws(() => validateLiquidationSafety({ ...sample, exchange, marginMode }), /requires isolated/);
  });
  test(`${exchange}: missing maintenance rules fail closed`, () => {
    assert.throws(() => validateLiquidationSafety({ ...sample, exchange, rules: { ...rules, tiers: [] } }), /no verified maintenance tier/);
    assert.throws(() => validateLiquidationSafety({ ...sample, exchange, rules: { ...rules, tiers: [{ ...rules.tiers[0]!, maintenanceRate: "NaN" }] } }), /unavailable or invalid/);
  });
}

test("Bybit applies the API maintenance deduction and rejects its absence", () => {
  const result = validateLiquidationSafety({ ...sample, rules: { ...rules, tiers: [{ ...rules.tiers[0]!, maintenanceDeduction: "1" }] } });
  const baseline = validateLiquidationSafety(sample);
  assert.ok(new D(result.estimatedLiquidationPrice).lt(baseline.estimatedLiquidationPrice));
  assert.throws(() => validateLiquidationSafety({ ...sample, rules: { ...rules, tiers: [{ maximumNotional: "1000000", maximumLeverage: "100", maintenanceRate: "0.005" }] } }), /Bybit maintenance deduction/);
});

test("OKX uses native contracts to select the maintenance tier at liquidation", () => {
  const converted = { ...rules, contractSize: "0.01", tiers: [{ maximumOrderQuantity: "1", maximumLeverage: "100", maintenanceRate: "0.005" }] };
  const result = validateLiquidationSafety({ ...sample, exchange: "okx", orderQuantity: "1", rules: converted });
  assert.equal(result.estimatedLiquidationPrice, validateLiquidationSafety({ ...sample, exchange: "okx" }).estimatedLiquidationPrice);
});

test("Bitget rejects unverified tier deductions and a short crossing the first tier limit", () => {
  const first = { ...rules.tiers[0]!, maximumNotional: "620" };
  assert.throws(() => validateLiquidationSafety({ ...sample, exchange: "bitget", direction: "sell", stop: "61000", rules: { ...rules, tiers: [first] } }), /no verified maintenance tier/);
  assert.throws(() => validateLiquidationSafety({ ...sample, exchange: "bitget", rules: { ...rules, tiers: [{ ...first, minimumNotional: "500" }] } }), /no verified maintenance tier/);
});

test("configurable clearance rejects a stop beyond liquidation's safety buffer", () => {
  const previous = process.env.LIQUIDATION_SAFETY_BUFFER_RATE;
  try {
    process.env.LIQUIDATION_SAFETY_BUFFER_RATE = "0.1";
    const input = { ...sample, stop: "54700" };
    assert.throws(() => validateLiquidationSafety(input), /too close/);
    process.env.LIQUIDATION_SAFETY_BUFFER_RATE = "0.001";
    assert.doesNotThrow(() => validateLiquidationSafety(input));
    process.env.LIQUIDATION_SAFETY_BUFFER_RATE = "0";
    assert.throws(() => validateLiquidationSafety(sample), /invalid/);
  } finally { if (previous === undefined) delete process.env.LIQUIDATION_SAFETY_BUFFER_RATE; else process.env.LIQUIDATION_SAFETY_BUFFER_RATE = previous; }
});
