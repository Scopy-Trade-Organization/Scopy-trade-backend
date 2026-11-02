export const RANKS = [
  { level: 0, name: "Newcomer", copiers: 0, trades: 0, winRate: 0, maxDrawdown: 100, bonus: 0 },
  { level: 1, name: "Starter", copiers: 50, trades: 50, winRate: 70, maxDrawdown: 25, bonus: 50 },
  { level: 2, name: "Growth", copiers: 200, trades: 50, winRate: 70, maxDrawdown: 25, bonus: 200 },
  { level: 3, name: "Pro", copiers: 500, trades: 50, winRate: 70, maxDrawdown: 25, bonus: 500 },
  { level: 4, name: "Elite", copiers: 1000, trades: 60, winRate: 70, maxDrawdown: 25, bonus: 1200 },
  { level: 5, name: "Legend", copiers: 2000, trades: 60, winRate: 70, maxDrawdown: 25, bonus: 2400 },
] as const;
export type RankMetrics = { activeCopiers: number; closedTrades: number; winRate: number; maxDrawdown: number | null };
export function qualifies(metrics: RankMetrics, rank: typeof RANKS[number]) {
  return rank.level === 0 || (metrics.activeCopiers >= rank.copiers && metrics.closedTrades >= rank.trades && metrics.winRate >= rank.winRate && metrics.maxDrawdown !== null && metrics.maxDrawdown < rank.maxDrawdown);
}
export function retainedLevel(earnedLevels: number[], activeCopiers: number) {
  return RANKS.filter(rank => earnedLevels.includes(rank.level) && activeCopiers >= rank.copiers / 2).at(-1)?.level ?? 0;
}

// Closed-trade equity curve, normalized by each trade's recorded sizing balance.
// Missing PnL or sizing evidence makes drawdown unknown, preventing promotion.
export function performance(trades: Array<{ realizedPnl?: string | null; tradeResult?: string | null; rawOrderResponse?: any }>) {
  let equity = 1, peak = 1, maxDrawdown = 0, known = trades.length > 0;
  for (const trade of trades) {
    const balance = Number(trade.rawOrderResponse?.sizing?.balance);
    const pnl = trade.realizedPnl == null ? NaN : Number(trade.realizedPnl);
    if (!Number.isFinite(balance) || balance <= 0 || !Number.isFinite(pnl)) { known = false; continue; }
    equity = Math.max(0, equity * (1 + pnl / balance));
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
  }
  return { closedTrades: trades.length, winRate: trades.length ? trades.filter(t => t.tradeResult === "profit").length / trades.length * 100 : 0, maxDrawdown: known ? maxDrawdown : null };
}
