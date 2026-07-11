import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { generatePkce, randomState } from "./pkce.js";

describe("PKCE", () => {
  it("derives an S256 challenge from the verifier", () => {
    const { verifier, challenge } = generatePkce();
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("uses url-safe base64 without padding", () => {
    const { verifier, challenge } = generatePkce();
    for (const v of [verifier, challenge]) {
      expect(v).not.toMatch(/[+/=]/);
    }
  });

  it("produces unique state values", () => {
    expect(randomState()).not.toBe(randomState());
  });
});
