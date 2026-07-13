import { randomUUID } from "node:crypto";
import type { TokenStore, TokenSummary, User, UserStore } from "../../ports/identity.js";
import { generateBearerToken, hashToken } from "../crypto/tokens.js";

interface TokenRow {
  id: string;
  userId: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revoked: boolean;
}

/**
 * In-memory TokenStore. Persists only token hashes (like the Postgres adapter),
 * and resolves a presented token back to its user via the injected UserStore.
 */
export class InMemoryTokenStore implements TokenStore {
  private readonly byHash = new Map<string, TokenRow>();

  constructor(private readonly users: UserStore) {}

  async mint(userId: string, name: string): Promise<{ token: string }> {
    const token = generateBearerToken();
    this.byHash.set(hashToken(token), {
      id: randomUUID(),
      userId,
      name,
      createdAt: new Date(),
      lastUsedAt: null,
      revoked: false,
    });
    return { token };
  }

  async resolve(rawToken: string): Promise<User | null> {
    const row = this.byHash.get(hashToken(rawToken));
    if (!row || row.revoked) return null;
    row.lastUsedAt = new Date();
    return this.users.getById(row.userId);
  }

  async revoke(rawToken: string): Promise<void> {
    const row = this.byHash.get(hashToken(rawToken));
    if (row) row.revoked = true;
  }

  async listActive(userId: string): Promise<TokenSummary[]> {
    return [...this.byHash.values()]
      .filter((r) => r.userId === userId && !r.revoked)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
      }));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    for (const row of this.byHash.values()) {
      if (row.userId === userId) row.revoked = true;
    }
  }
}
