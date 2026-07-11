import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { AesGcmCrypto } from "./aesgcm.js";

describe("AesGcmCrypto", () => {
  const crypto = new AesGcmCrypto(randomBytes(32));

  it("round-trips plaintext", () => {
    const secret = "ya29.a0-upstream-oauth-token";
    expect(crypto.decrypt(crypto.encrypt(secret))).toBe(secret);
  });

  it("produces distinct ciphertexts for the same plaintext (random IV)", () => {
    expect(crypto.encrypt("x")).not.toBe(crypto.encrypt("x"));
  });

  it("rejects a tampered ciphertext", () => {
    const ct = Buffer.from(crypto.encrypt("hello"), "base64");
    ct[ct.length - 1] ^= 0x01;
    expect(() => crypto.decrypt(ct.toString("base64"))).toThrow();
  });

  it("requires a 32-byte key", () => {
    expect(() => new AesGcmCrypto(randomBytes(16))).toThrow(/32 bytes/);
  });
});
