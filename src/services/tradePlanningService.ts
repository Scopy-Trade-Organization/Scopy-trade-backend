import {
  D,
  decimal,
  calculateTradeRisk,
  TradeRiskError,
} from "./tradeRiskService.js";
import { getFuturesContext } from "./futuresExchangeService.js";
import { getCurrentPrice } from "./tradeService.js";
import { shouldRebaseTestnetSignals } from "./exchangeEnvironment.js";
import {
  DEFAULT_MAX_ENTRY_DEVIATION,
  SUPPORTED_PAIRS,
  SUPPORTED_TRADE_EXCHANGES,
} from "../constants.js";
import type { ExchangeId, RawCredentials } from "../types/index.js";

export interface PlanningDependencies {
  getFuturesContext?: typeof getFuturesContext;
  getCurrentPrice?: typeof getCurrentPrice;
}

/** Read-only preparation shared by preview, manual execution and every copier. */
export async function planTrade(
  exchange: ExchangeId,
  credentials: RawCredentials,
  signal: {
    pair: string;
    direction: "buy" | "sell";
    entry: string;
    sl: string;
    tp: string;
  },
  dependencies: PlanningDependencies = {},
) {
  if (!SUPPORTED_TRADE_EXCHANGES.includes(exchange))
    throw new TradeRiskError(
      "UNSUPPORTED_EXCHANGE",
      "Exchange is not supported for trading.",
    );
  const pair = signal.pair.toUpperCase().replace(/[/-]/g, "");
  if (!SUPPORTED_PAIRS.includes(pair as any))
    throw new TradeRiskError(
      "UNSUPPORTED_INSTRUMENT",
      "Trading pair is not currently supported.",
    );
  const entry = decimal(signal.entry, "Signal entry");
  const market = await (dependencies.getCurrentPrice ?? getCurrentPrice)(
    exchange,
    pair,
  );
  const current = decimal(market.price, "Current market price");
  const deviation = current.minus(entry).abs().div(entry);
  const configured = Number(process.env.TRADE_ENTRY_DEVIATION_LIMIT);
  const maxDeviation =
    Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_MAX_ENTRY_DEVIATION;
  const rebased = shouldRebaseTestnetSignals();
  if (!rebased && deviation.gt(maxDeviation))
    throw new TradeRiskError(
      "ENTRY_DEVIATION",
      "Current market price is too far from the signal entry price.",
    );
  const scale = rebased ? current.div(entry) : new D(1);
  const context = await (dependencies.getFuturesContext ?? getFuturesContext)(
    exchange,
    credentials,
    pair,
  );
  const sizing = calculateTradeRisk({
    exchange,
    ...context,
    entry: rebased ? current.toFixed() : entry.toFixed(),
    sl: decimal(signal.sl, "Signal stop").mul(scale).toFixed(),
    tp: decimal(signal.tp, "Signal target").mul(scale).toFixed(),
    direction: signal.direction,
  });
  return {
    sizing,
    context,
    currentMarketPrice: market.price,
    signalPricesRebased: rebased,
    deviation: deviation.toNumber(),
    maxDeviation,
  };
}
