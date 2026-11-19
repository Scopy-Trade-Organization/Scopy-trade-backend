import axios from "axios";
import { MAINNET_USDT, liveClient } from "./proFinanceService.js";

export const MAX_WITHDRAWAL_BYTES = 1024;
const MAX_ENERGY_FEE_SUN = 100_000_000;

export function networkFeeUnits(sun: number, trxPriceUnits: number) {
  if (
    !Number.isSafeInteger(sun) ||
    sun < 0 ||
    !Number.isSafeInteger(trxPriceUnits) ||
    trxPriceUnits < 1
  )
    throw new Error("Invalid network fee evidence.");
  const units = Number(
    (BigInt(sun) * BigInt(trxPriceUnits) + 999_999n) / 1_000_000n,
  );
  if (!Number.isSafeInteger(units))
    throw new Error("Network fee exceeds supported precision.");
  return units;
}

/** Live public TRX/USDT conversion, locked for this quote and its reconciliation. */
export async function getTrxPriceUnits() {
  const { data } = await axios.get("https://www.okx.com/api/v5/market/ticker", {
    params: { instId: "TRX-USDT" },
    timeout: 10_000,
  });
  if (data?.code !== "0") throw new Error("TRX price temporarily unavailable.");
  const units = Math.ceil(Number(data?.data?.[0]?.last) * 1_000_000);
  if (!Number.isSafeInteger(units) || units < 1)
    throw new Error("TRX price temporarily unavailable.");
  return units;
}

export async function quoteWithdrawalFee(
  units: number,
  address: string,
  clientFactory = liveClient,
  priceFactory = getTrxPriceUnits,
) {
  const tron = clientFactory(),
    sender = tron.defaultAddress.base58;
  if (!sender) throw new Error("Payout wallet unavailable.");
  const transfer = [
    { type: "address", value: address },
    { type: "uint256", value: String(units) },
  ];
  const estimateEnergy = async () => {
    try {
      const estimate = await tron.transactionBuilder.estimateEnergy(
        MAINNET_USDT,
        "transfer(address,uint256)",
        {},
        transfer,
        sender,
      );
      if (estimate.result?.result && estimate.energy_required) return estimate;
    } catch {
      /* Some providers disable estimateEnergy; simulate the same transfer instead. */
    }
    const simulated = await tron.transactionBuilder.triggerConstantContract(
      MAINNET_USDT,
      "transfer(address,uint256)",
      {},
      transfer,
      sender,
    );
    return { result: simulated.result, energy_required: simulated.energy_used };
  };
  const [parameters, estimate, trxPriceUnits] = await Promise.all([
    tron.trx.getChainParameters(),
    estimateEnergy(),
    priceFactory(),
  ]);
  const parameter = (key: string) =>
    Number(parameters.find((item) => item.key === key)?.value);
  const energyPrice = parameter("getEnergyFee"),
    bandwidthSunPerByte = parameter("getTransactionFee");
  const maxFeeLimit = parameter("getMaxFeeLimit");
  const feeLimitSun = Math.ceil(
    Number(estimate.energy_required) * energyPrice * 1.25,
  );
  if (
    ![energyPrice, bandwidthSunPerByte, feeLimitSun, maxFeeLimit].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    estimate.result?.result !== true ||
    feeLimitSun > MAX_ENERGY_FEE_SUN ||
    feeLimitSun > maxFeeLimit
  ) {
    throw new Error(
      "A safe withdrawal network fee could not be quoted. Try again later.",
    );
  }
  const networkFeeReserveUnits = networkFeeUnits(
    feeLimitSun + MAX_WITHDRAWAL_BYTES * bandwidthSunPerByte,
    trxPriceUnits,
  );
  if (!Number.isSafeInteger(units) || units <= networkFeeReserveUnits)
    throw new Error("Withdrawal amount must exceed its network fee reserve.");
  return {
    payoutUnits: units - networkFeeReserveUnits,
    networkFeeReserveUnits,
    feeLimitSun,
    bandwidthSunPerByte,
    trxPriceUnits,
    quoteExpiresAt: new Date(Date.now() + 10 * 60_000),
  };
}

export function assertWithdrawalSize(transaction: any) {
  if (
    !/^(?:[a-f0-9]{2})+$/i.test(transaction.raw_data_hex || "") ||
    transaction.signature?.length !== 1 ||
    !/^[a-f0-9]{130}$/i.test(transaction.signature[0])
  )
    throw new Error("Unexpected signed payout encoding.");
  // Protobuf field overhead and result reservation are included in this allowance.
  const bytes =
    transaction.raw_data_hex.length / 2 +
    transaction.signature[0].length / 2 +
    128;
  if (
    bytes > MAX_WITHDRAWAL_BYTES ||
    transaction.raw_data?.data ||
    transaction.raw_data?.contract?.[0]?.Permission_id
  )
    throw new Error("Payout exceeds its quoted bandwidth budget.");
}

export async function withdrawalFeeEvidence(row: any, info: any) {
  if (
    !info?.id ||
    info.id !== row.transactionId ||
    !Number.isSafeInteger(info.blockNumber) ||
    info.blockNumber < 1
  )
    throw new Error("Confirmed fee evidence unavailable.");
  const sun = info.fee ?? 0; // TRON omits protobuf scalar fields when they are zero.
  if (
    !Number.isSafeInteger(sun) ||
    sun < 0 ||
    (info.receipt?.energy_fee ?? 0) + (info.receipt?.net_fee ?? 0) > sun
  )
    throw new Error("Invalid confirmed network fee.");
  const price = row.trxPriceUnits;
  return {
    networkFeeSun: sun,
    networkFeeUnits: networkFeeUnits(sun, price),
    trxPriceUnits: price,
  };
}
