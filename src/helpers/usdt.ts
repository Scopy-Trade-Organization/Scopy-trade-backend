/** USDT is stored as integer micro-units, never floating-point balances. */
export function usdtUnits(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,9})(\.\d{1,6})?$/.test(value)) {
    throw new Error("Enter a USDT amount with at most 6 decimal places.");
  }
  const [whole, fraction = ""] = value.split(".");
  const units = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount is too large.");
  return Number(units);
}

export function formatUsdt(units: number): string {
  if (!Number.isSafeInteger(units) || units < 0) throw new Error("Invalid USDT balance.");
  return `${Math.floor(units / 1_000_000)}.${String(units % 1_000_000).padStart(6, "0")}`;
}

export function profitSplit(profit: string) {
  const units = BigInt(usdtUnits(profit));
  const fee = units * 20n / 100n;
  const pro = units * 5n / 100n;
  return { platformFee: formatUsdt(Number(fee)), proTraderShare: formatUsdt(Number(pro)), platformShare: formatUsdt(Number(fee - pro)) };
}
