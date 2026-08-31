import crypto from "crypto";

/**
 * Self-contained TRON (TRC-20) address validation via base58check.
 *
 * A TRON address is base58check(0x41 ‖ 20-byte account hash), which renders as
 * a 34-character string beginning with "T". The final 4 bytes are a checksum
 * (first 4 bytes of the double-SHA256 of the 21-byte payload). Validating the
 * checksum — not just the "T" prefix and length — is what stops a mistyped or
 * truncated address from being accepted and funds being sent into a black hole.
 *
 * The 0x41 prefix is shared by TRON mainnet and the Shasta/Nile testnets, so
 * this validator accepts both (network selection is a node/host concern, not an
 * address-format one).
 *
 * Implemented without tronweb so it stays pure and unit-testable with no network
 * or heavy runtime dependency.
 */

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const ALPHABET_MAP = new Map<string, bigint>();
[...BASE58_ALPHABET].forEach((char, index) => {
  ALPHABET_MAP.set(char, BigInt(index));
});

function base58Decode(input: string): Buffer | null {
  if (input.length === 0) return null;

  let value = 0n;
  for (const char of input) {
    const digit = ALPHABET_MAP.get(char);
    if (digit === undefined) return null; // non-base58 character
    value = value * 58n + digit;
  }

  const bytes: number[] = [];
  while (value > 0n) {
    bytes.push(Number(value % 256n));
    value = value / 256n;
  }
  bytes.reverse();

  // Each leading "1" in base58 encodes a leading zero byte.
  for (const char of input) {
    if (char === "1") bytes.unshift(0);
    else break;
  }

  return Buffer.from(bytes);
}

export function isValidTronAddress(address: unknown): address is string {
  if (typeof address !== "string") return false;
  if (address.length !== 34) return false;
  if (!address.startsWith("T")) return false;

  const decoded = base58Decode(address);
  if (!decoded || decoded.length !== 25) return false;
  if (decoded.readUInt8(0) !== 0x41) return false; // TRON address prefix

  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21, 25);
  const hash = crypto
    .createHash("sha256")
    .update(crypto.createHash("sha256").update(payload).digest())
    .digest();

  return checksum.equals(hash.subarray(0, 4));
}
