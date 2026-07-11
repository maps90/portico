import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryUserStore } from "./user-store.js";
import { InMemoryTokenStore } from "./token-store.js";

describe("InMemoryTokenStore", () => {
  let users: InMemoryUserStore;
  let tokens: InMemoryTokenStore;
  let userId: string;

  beforeEach(async () => {
    users = new InMemoryUserStore();
    tokens = new InMemoryTokenStore(users);
    const u = await users.upsertByIdentity({ issuer: "i", subject: "s", email: null });
    userId = u.id;
  });

  it("mints an portico-prefixed token that resolves to the user", async () => {
    const { token } = await tokens.mint(userId, "login");
    expect(token.startsWith("portico_")).toBe(true);
    const resolved = await tokens.resolve(token);
    expect(resolved?.id).toBe(userId);
  });

  it("returns null for an unknown token", async () => {
    expect(await tokens.resolve("portico_nope")).toBeNull();
  });

  it("stops resolving a revoked token", async () => {
    const { token } = await tokens.mint(userId, "login");
    await tokens.revoke(token);
    expect(await tokens.resolve(token)).toBeNull();
  });
});
