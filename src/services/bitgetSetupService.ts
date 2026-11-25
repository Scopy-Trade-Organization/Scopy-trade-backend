import { randomUUID } from "node:crypto";
import { SUPPORTED_PAIRS } from "../constants.js";
import { ExchangeConnection } from "../models/exchangeConnectionModel.js";
import type { BitgetMarginSetup, RawCredentials } from "../types/index.js";
import { exchangeApi, type ExchangeRequest } from "./exchangeApiService.js";
import { assertSymbolFree } from "./futuresExchangeService.js";
import { assertBitgetAccountSettings, BITGET_CATEGORY, bitgetList, bitgetSymbolSettings } from "./bitgetUtaService.js";
import { decimal, TradeRiskError } from "./tradeRiskService.js";

type PairSetup = BitgetMarginSetup["pairs"][number];
const hasIsolatedConfig = (data: any, symbol: string) => bitgetList(data.symbolConfigList, "symbol settings")
  .some(r => r.symbol === symbol && r.category === BITGET_CATEGORY && r.marginMode === "isolated");

/** Called under the connection execution lock. Never changes account/holding modes. */
export async function prepareBitgetPair(credentials: RawCredentials, symbol: string, api = exchangeApi("bitget", credentials)): Promise<PairSetup> {
  if (!SUPPORTED_PAIRS.includes(symbol as typeof SUPPORTED_PAIRS[number])) {
    throw new TradeRiskError("UNSUPPORTED_INSTRUMENT", "Automatic Bitget setup is limited to supported trading pairs.");
  }
  const settings = await api("GET", "/api/v3/account/settings");
  assertBitgetAccountSettings(settings.data);
  // Existing isolated settings, including leverage, are preserved.
  if (hasIsolatedConfig(settings.data, symbol)) return { symbol, status: "ready" };

  const instruments = await api("GET", "/api/v3/market/instruments", { category: BITGET_CATEGORY, symbol });
  const instrument = bitgetList(instruments.data, "instruments").find(r => r.symbol === symbol && r.category === BITGET_CATEGORY);
  if (!instrument || instrument.status !== "online" || instrument.type !== "perpetual" || instrument.quoteCoin !== "USDT") {
    throw new TradeRiskError("UNSUPPORTED_INSTRUMENT", "This pair is unavailable for Bitget UTA USDT perpetual trading.");
  }
  const leverage = decimal(instrument.minLeverage, "Bitget minimum leverage").toFixed();
  for (const posSide of ["long", "short"]) {
    // Recheck exposure before each mutation, including manual/external orders.
    await assertSymbolFree("bitget", api, symbol);
    const latest = await api("GET", "/api/v3/account/settings");
    assertBitgetAccountSettings(latest.data);
    await api("POST", "/api/v3/account/set-leverage", {
      category: BITGET_CATEGORY, symbol, marginMode: "isolated", posSide, leverage,
    });
  }
  const confirmed = await api("GET", "/api/v3/account/settings");
  const config = bitgetSymbolSettings(confirmed.data, symbol);
  if (!decimal(config.leverage, "Bitget isolated leverage").eq(leverage)) {
    throw new TradeRiskError("LEVERAGE_VERIFICATION_FAILED", "Bitget did not confirm automatic isolated-margin setup. Test the connection to retry.");
  }
  return { symbol, status: "configured" };
}

function failedPair(symbol: string, error: unknown): PairSetup {
  const blocked = error instanceof TradeRiskError && ["EXISTING_EXPOSURE", "UNSUPPORTED_ACCOUNT_MODE", "EXECUTION_BUSY"].includes(error.code);
  return { symbol, status: blocked ? "blocked" : "failed", message: error instanceof TradeRiskError ? error.message : "Automatic setup is temporarily unavailable. Test the connection to retry." };
}

export async function configureBitgetSupportedPairs(credentials: RawCredentials, api: ExchangeRequest = exchangeApi("bitget", credentials)): Promise<BitgetMarginSetup> {
  const pairs: PairSetup[] = [];
  try {
    assertBitgetAccountSettings((await api("GET", "/api/v3/account/settings")).data);
  } catch (error) {
    return { checkedAt: new Date().toISOString(), pairs: SUPPORTED_PAIRS.map(symbol => failedPair(symbol, error)) };
  }
  // Sequential writes avoid bursting the exchange's configuration rate limit.
  for (const symbol of SUPPORTED_PAIRS) {
    try { pairs.push(await prepareBitgetPair(credentials, symbol, api)); }
    catch (error) { pairs.push(failedPair(symbol, error)); }
  }
  return { checkedAt: new Date().toISOString(), pairs };
}

/** Connection tests and trading share a database lock so they cannot reconfigure concurrently. */
export async function setupBitgetConnection(connectionId: string, credentials: RawCredentials): Promise<BitgetMarginSetup> {
  const token = randomUUID();
  const locked = await ExchangeConnection.findOneAndUpdate({ _id: connectionId, exchange: "bitget", isActive: true,
    $or: [{ executionLockUntil: null }, { executionLockUntil: { $lte: new Date() } }],
  }, { $set: { executionLockToken: token, executionLockUntil: new Date(Date.now() + 5 * 60_000) } });
  if (!locked) return { checkedAt: new Date().toISOString(), pairs: SUPPORTED_PAIRS.map(symbol => failedPair(symbol,
    new TradeRiskError("EXECUTION_BUSY", "Another operation is using this exchange connection. Test the connection again when it finishes."))) };
  try { return await configureBitgetSupportedPairs(credentials); }
  finally {
    await ExchangeConnection.updateOne({ _id: connectionId, executionLockToken: token }, { $unset: { executionLockToken: 1, executionLockUntil: 1 } });
  }
}
