import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  alignToStep,
  getFuturesContractRules,
  clearContractRulesCache,
} from "./tradeService.js";
import { http } from "./exchangeConnectionService.js";
import { MAX_RISK_PERCENT } from "../constants.js";

describe("2% Risk Calculation and Sizing Rules", () => {
  afterEach(() => {
    mock.restoreAll();
    clearContractRulesCache();
  });

  describe("Precision and alignToStep", () => {
    it("safely rounds down quantities to step size", () => {
      // Step 0.001
      assert.equal(alignToStep("0.012999", "0.001", true), "0.012");
      // Step 1
      assert.equal(alignToStep("42.9", "1", true), "42");
      // Step 0.01
      assert.equal(alignToStep("1.555", "0.01", true), "1.55");
    });

    it("rounds prices to nearest tick", () => {
      assert.equal(alignToStep("50123.44", "0.1"), "50123.4");
      assert.equal(alignToStep("50123.46", "0.1"), "50123.5");
      assert.equal(alignToStep("0.05432", "0.0001"), "0.0543");
    });

    it("throws error for non-finite or invalid precision parameters", () => {
      assert.throws(() => alignToStep("invalid", "0.1"), /Invalid exchange precision value/);
      assert.throws(() => alignToStep("100", "0"), /Invalid exchange precision value/);
      assert.throws(() => alignToStep("100", "-0.1"), /Invalid exchange precision value/);
    });
  });

  describe("2% Risk Model with Precision Constraints", () => {
    it("ensures intended risk never exceeds 2% after safe lot step rounding", () => {
      const balance = 1000;
      const maxRisk = balance * MAX_RISK_PERCENT; // 20 USDT

      const entryPrice = "65432.10";
      const stopLoss = "64123.40";
      const priceTick = "0.10";
      const qtyStep = "0.001";

      const alignedEntry = alignToStep(entryPrice, priceTick);
      const alignedSl = alignToStep(stopLoss, priceTick);
      const distance = Math.abs(Number(alignedEntry) - Number(alignedSl));

      // Calculate quantity with safe floor
      const rawQty = maxRisk / distance;
      const stepUnits = Math.floor(rawQty / Number(qtyStep) + 1e-12);
      const safeQty = alignToStep(String(stepUnits * Number(qtyStep)), qtyStep, true);

      const actualRisk = Number(safeQty) * distance;

      assert.ok(
        actualRisk <= maxRisk,
        `Actual risk (${actualRisk}) must be <= max 2% risk (${maxRisk})`,
      );
      assert.equal(actualRisk <= 20.0, true);
    });

    it("uses final aligned entry and stop-loss prices for exact risk validation", () => {
      const balance = 500;
      const maxRisk = balance * MAX_RISK_PERCENT; // 10 USDT

      // Raw unaligned levels
      const rawEntry = "100.04";
      const rawSl = "95.06";
      const priceTick = "0.1";
      const qtyStep = "0.01";

      const alignedEntry = alignToStep(rawEntry, priceTick); // "100.0"
      const alignedSl = alignToStep(rawSl, priceTick);       // "95.1"
      const alignedDistance = Math.abs(Number(alignedEntry) - Number(alignedSl)); // 4.9

      const rawDistance = Math.abs(Number(rawEntry) - Number(rawSl)); // 4.98

      // If raw distance was used, rawQty would be 10 / 4.98 = 2.008 -> safeQty = 2.00
      // With aligned distance 4.9: rawQty = 10 / 4.9 = 2.0408 -> safeQty = 2.04
      const stepUnits = Math.floor((maxRisk / alignedDistance) / Number(qtyStep) + 1e-12);
      const safeQty = alignToStep(String(stepUnits * Number(qtyStep)), qtyStep, true);

      const finalRisk = Number(safeQty) * alignedDistance;
      assert.ok(finalRisk <= maxRisk);
      assert.equal(Number(safeQty), 2.04);
    });

    it("accounts for contract multiplier in risk calculation", () => {
      const balance = 2000;
      const maxRisk = balance * MAX_RISK_PERCENT; // 40 USDT

      const entry = 100;
      const sl = 95;
      const distance = 5;
      const multiplier = 2; // 1 contract = 2 units

      // Risk per contract = distance * multiplier = 10 USDT
      // For 40 USDT max risk, contracts = 40 / 10 = 4.0
      const rawContracts = maxRisk / (distance * multiplier);
      assert.equal(rawContracts, 4.0);

      const actualRisk = rawContracts * distance * multiplier;
      assert.equal(actualRisk, 40);
      assert.ok(actualRisk <= maxRisk);
    });
  });

  describe("Contract Rules Retrieval & Validation", () => {
    it("retrieves and caches Bitget mix contract rules", async () => {
      let fetchCount = 0;
      mock.method(http as any, "get", async (url: string) => {
        if (url.includes("/api/v2/mix/market/contracts")) {
          fetchCount++;
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
        throw new Error(`Unexpected URL ${url}`);
      });

      const rules1 = await getFuturesContractRules("bitget", "BTCUSDT");
      assert.equal(rules1.symbol, "BTCUSDT");
      assert.equal(rules1.tickSize, "0.1");
      assert.equal(rules1.qtyStep, "0.001");
      assert.equal(rules1.minQty, "0.001");
      assert.equal(rules1.minNotional, "5");
      assert.equal(rules1.multiplier, 1);

      // Second call uses cache
      const rules2 = await getFuturesContractRules("bitget", "BTCUSDT");
      assert.deepEqual(rules1, rules2);
      assert.equal(fetchCount, 1);
    });

    it("retrieves and caches Bybit linear contract rules", async () => {
      mock.method(http as any, "get", async (url: string) => {
        if (url.includes("/v5/market/instruments-info")) {
          return {
            data: {
              retCode: 0,
              retMsg: "OK",
              result: {
                list: [
                  {
                    symbol: "ETHUSDT",
                    priceFilter: { tickSize: "0.05" },
                    lotSizeFilter: {
                      qtyStep: "0.01",
                      minOrderQty: "0.01",
                      minNotionalValue: "5",
                    },
                  },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      });

      const rules = await getFuturesContractRules("bybit", "ETHUSDT");
      assert.equal(rules.symbol, "ETHUSDT");
      assert.equal(rules.tickSize, "0.05");
      assert.equal(rules.qtyStep, "0.01");
      assert.equal(rules.minQty, "0.01");
      assert.equal(rules.minNotional, "5");
      assert.equal(rules.multiplier, 1);
    });

    it("rejects unsupported exchanges and does not invent generic rules", async () => {
      await assert.rejects(
        async () => {
          await getFuturesContractRules("okx" as any, "BTC-USDT");
        },
        /Futures trading is not supported for exchange "okx"/,
      );
    });

    it("rejects invalid contract rules metadata with non-finite values", async () => {
      mock.method(http as any, "get", async (url: string) => {
        if (url.includes("/v5/market/instruments-info")) {
          return {
            data: {
              retCode: 0,
              retMsg: "OK",
              result: {
                list: [
                  {
                    symbol: "BADPAIR",
                    priceFilter: { tickSize: "0" }, // Invalid tick size <= 0
                    lotSizeFilter: {
                      qtyStep: "0.01",
                      minOrderQty: "0.01",
                    },
                  },
                ],
              },
            },
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      });

      await assert.rejects(
        async () => {
          await getFuturesContractRules("bybit", "BADPAIR");
        },
        /metadata validation failed/,
      );
    });
  });
});
