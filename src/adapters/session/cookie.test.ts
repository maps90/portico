import { describe, it, expect } from "vitest";
import { SessionCodec } from "./cookie.js";

describe("SessionCodec", () => {
  it("round-trips a signed session to the user id", async () => {
    const codec = new SessionCodec("a-very-long-session-secret");
    const cookie = await codec.sign("user-42");
    expect(await codec.verify(cookie)).toBe("user-42");
  });

  it("rejects a cookie signed with a different secret", async () => {
    const a = new SessionCodec("secret-a-secret-a-secret-a");
    const b = new SessionCodec("secret-b-secret-b-secret-b");
    const cookie = await a.sign("user-42");
    expect(await b.verify(cookie)).toBeNull();
  });

  it("returns null for a missing or garbage cookie", async () => {
    const codec = new SessionCodec("a-very-long-session-secret");
    expect(await codec.verify(undefined)).toBeNull();
    expect(await codec.verify("not-a-jwt")).toBeNull();
  });
});
