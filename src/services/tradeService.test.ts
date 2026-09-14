import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { http } from "./exchangeConnectionService.js";
import { placeOrder } from "./tradeService.js";
import type { RawCredentials } from "../types/index.js";

const credentials: RawCredentials = {
  apiKey: "demo-key",
  apiSecret: "demo-secret",
  passphrase: "demo-passphrase",
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

afterEach(() => {
  mock.restoreAll();
  delete process.env.BITGET_DEMO_MODE;
});

function mockBitgetContract(): void {
  mock.method(http as any, "get", async () => ({
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
  }));
}

test("Bitget orders are aligned to contract rules before signing", async () => {
  process.env.BITGET_DEMO_MODE = "true";
  mockBitgetContract();
  let capturedBody = "";
  let capturedHeaders: Record<string, string> = {};
  mock.method(http as any, "post", async (_url: string, body: string, config: any) => {
    capturedBody = body;
    capturedHeaders = config.headers;
    return { data: { code: "00000", msg: "success", data: { orderId: "123" } } };
  });

  const result = await placeOrder("bitget", params);
  const body = JSON.parse(capturedBody);

  assert.equal(result.orderId, "123");
  assert.equal(body.size, "0.012");
  assert.equal(body.price, "50123.5");
  assert.equal(body.presetStopSurplusPrice, "51123.5");
  assert.equal(body.presetStopLossPrice, "49123.4");
  assert.equal(body.clientOid, "sc_test_order");
  assert.equal(capturedHeaders.paptrading, "1");
});

test("Bitget HTTP errors retain the safe exchange code and message", async () => {
  mockBitgetContract();
  mock.method(http as any, "post", async () => {
    throw {
      isAxiosError: true,
      response: {
        status: 400,
        data: { code: "45115", msg: "price must be a valid multiple" },
      },
    };
  });

  await assert.rejects(
    () => placeOrder("bitget", params),
    /Bitget order rejected \(45115\): price must be a valid multiple/,
  );
});

test("Bitget orders below the contract minimum are rejected locally", async () => {
  mockBitgetContract();

  await assert.rejects(
    () => placeOrder("bitget", { ...params, quantity: "0.0009" }),
    /below Bitget Futures minimum/,
  );
});
