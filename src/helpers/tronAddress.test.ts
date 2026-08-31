import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidTronAddress } from "./tronAddress.js";

// Known-valid mainnet addresses (base58check, 0x41 prefix).
const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const PLATFORM_WALLET = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";

test("accepts a well-formed TRON address", () => {
  assert.equal(isValidTronAddress(USDT_TRC20_CONTRACT), true);
});

test("accepts the platform receiving wallet baked into the code", () => {
  // Doubles as a guard that the hard-coded PLATFORM_USDT_WALLETS.TRON value is
  // itself a valid address.
  assert.equal(isValidTronAddress(PLATFORM_WALLET), true);
});

test("rejects an address with a corrupted checksum", () => {
  // Flip the final character — same length, still starts with T, valid base58.
  const corrupted = USDT_TRC20_CONTRACT.slice(0, -1) + "u";
  assert.equal(isValidTronAddress(corrupted), false);
});

test("rejects wrong length", () => {
  assert.equal(isValidTronAddress("T" + "1".repeat(20)), false);
  assert.equal(isValidTronAddress(USDT_TRC20_CONTRACT + "1"), false);
});

test("rejects addresses not starting with T", () => {
  assert.equal(isValidTronAddress("R" + USDT_TRC20_CONTRACT.slice(1)), false);
});

test("rejects an Ethereum-style address", () => {
  assert.equal(
    isValidTronAddress("0x1111111111111111111111111111111111111111"),
    false,
  );
});

test("rejects strings containing non-base58 characters", () => {
  // 0, O, I, l are not in the base58 alphabet.
  assert.equal(isValidTronAddress("T00000000000000000000000000000000O"), false);
});

test("rejects empty / non-string input", () => {
  assert.equal(isValidTronAddress(""), false);
  assert.equal(isValidTronAddress(undefined), false);
  assert.equal(isValidTronAddress(null), false);
  assert.equal(isValidTronAddress(12345), false);
  assert.equal(isValidTronAddress({}), false);
});
