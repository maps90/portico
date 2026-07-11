import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * AES-256-GCM envelope for the upstream-token vault. Ciphertext layout:
 *   base64( iv[12] || authTag[16] || ciphertext )
 * The 32-byte key comes from `PORTICO_ENCRYPTION_KEY` (Key Vault in prod).
 */
export class AesGcmCrypto {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new Error(`encryption key must be 32 bytes, got ${key.length}`);
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString("base64");
  }

  decrypt(payload: string): string {
    const buf = Buffer.from(payload, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  }
}
