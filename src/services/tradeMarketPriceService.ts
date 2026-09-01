import { getCurrentPrice } from "./tradeService.js";
import { ExchangeId } from "../types/index.js";

type TradeWithExchange = {
  pair: string;
  status: string;
  exchangeConnectionId?: unknown;
};

/**
 * Adds a best-effort public market quote to active-trade API responses.
 * A quote outage must never prevent users from seeing their orders.
 */
export async function withCurrentMarketPrices<T extends TradeWithExchange>(
  trades: T[],
): Promise<Array<T & { currentMarketPrice: string | null; currentMarketPriceUpdatedAt: Date | null }>> {
  const prices = new Map<string, Promise<string | null>>();
  const quotedAt = new Date();

  return Promise.all(
    trades.map(async (trade) => {
      if (!['pending', 'filled'].includes(trade.status)) {
        return { ...trade, currentMarketPrice: null, currentMarketPriceUpdatedAt: null };
      }

      const connection = trade.exchangeConnectionId as { exchange?: string } | null;
      const exchange = connection && typeof connection === "object"
        ? connection.exchange
        : undefined;
      if (!exchange) {
        return { ...trade, currentMarketPrice: null, currentMarketPriceUpdatedAt: null };
      }

      const key = `${exchange}:${trade.pair}`;
      let price = prices.get(key);
      if (!price) {
        price = getCurrentPrice(exchange as ExchangeId, trade.pair)
          .then((result) => result.price)
          .catch(() => null);
        prices.set(key, price);
      }

      const currentMarketPrice = await price;
      return {
        ...trade,
        currentMarketPrice,
        currentMarketPriceUpdatedAt: currentMarketPrice ? quotedAt : null,
      };
    }),
  );
}
