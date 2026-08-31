import { test, after } from "node:test";
import assert from "node:assert/strict";
import { encryptCredentials, decryptCredentials } from "./exchangeConnectionService.js";
import type { RawCredentials } from "../types/index.js";

// getEncryptionKey() reads EXCHANGE_ENCRYPTION_KEY at call time, so setting it
// here (before any encrypt/decrypt call) is sufficient. 64 hex chars = 32 bytes.
const savedKey = process.env.EXCHANGE_ENCRYPTION_KEY;
process.env.EXCHANGE_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

after(() => {
  if (savedKey === undefined) delete process.env.EXCHANGE_ENCRYPTION_KEY;
  else process.env.EXCHANGE_ENCRYPTION_KEY = savedKey;
});

test("round-trips credentials through encrypt/decrypt", () => {
  const raw: RawCredentials = {
    apiKey: "myApiKey",
    apiSecret: "myApiSecret",
    passphrase: "myPassphrase",
  };
  const enc = encryptCredentials("okx", raw);
  assert.equal(enc.exchange, "okx");
  // Stored form must not equal the plaintext.
  assert.notEqual(enc.apiKey, raw.apiKey);
  assert.notEqual(enc.apiSecret, raw.apiSecret);

  const dec = decryptCredentials(enc);
  assert.equal(dec.exchange, "okx");
  assert.equal(dec.apiKey, raw.apiKey);
  assert.equal(dec.apiSecret, raw.apiSecret);
  assert.equal(dec.passphrase, raw.passphrase);
});

test("stored ciphertext uses the iv:authTag:ciphertext envelope", () => {
  const enc = encryptCredentials("binance", { apiKey: "k", apiSecret: "s" });
  const parts = enc.apiKey.split(":");
  assert.equal(parts.length, 3);
  // 12-byte IV → 24 hex chars; 16-byte GCM auth tag → 32 hex chars.
  assert.equal(parts[0]!.length, 24);
  assert.equal(parts[1]!.length, 32);
});

test("encrypting the same value twice yields different ciphertext (random IV)", () => {
  const a = encryptCredentials("binance", { apiKey: "same", apiSecret: "s" });
  const b = encryptCredentials("binance", { apiKey: "same", apiSecret: "s" });
  assert.notEqual(a.apiKey, b.apiKey);
});

test("omits the passphrase when none is supplied", () => {
  const enc = encryptCredentials("binance", { apiKey: "k", apiSecret: "s" });
  assert.equal(enc.passphrase, undefined);
  const dec = decryptCredentials(enc);
  assert.equal(dec.passphrase, undefined);
});

test("rejects tampered ciphertext (GCM auth tag catches mutation)", () => {
  const enc = encryptCredentials("binance", { apiKey: "k", apiSecret: "s" });
  const [iv, tag, cipher] = enc.apiKey.split(":") as [string, string, string];
  // Flip the final hex digit of the ciphertext — a valid-hex but altered payload.
  const flipped = cipher.slice(0, -1) + (cipher.slice(-1) === "a" ? "b" : "a");
  const tampered = { ...enc, apiKey: [iv, tag, flipped].join(":") };
  assert.throws(() => decryptCredentials(tampered));
});

test("rejects a malformed stored value", () => {
  const enc = encryptCredentials("binance", { apiKey: "k", apiSecret: "s" });
  const malformed = { ...enc, apiKey: "not-a-valid-envelope" };
  assert.throws(() => decryptCredentials(malformed), /Malformed encrypted value/);
});
