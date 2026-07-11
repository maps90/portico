import type { TokenStore, User, UserStore } from "../../ports/identity.js";
import { generateBearerToken, hashToken } from "../crypto/tokens.js";

interface TokenRow {
  userId: string;
  name: string;
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
    this.byHash.set(hashToken(token), { userId, name, revoked: false });
    return { token };
  }

  async resolve(rawToken: string): Promise<User | null> {
    const row = this.byHash.get(hashToken(rawToken));
    if (!row || row.revoked) return null;
    return this.users.getById(row.userId);
  }

  async revoke(rawToken: string): Promise<void> {
    const row = this.byHash.get(hashToken(rawToken));
    if (row) row.revoked = true;
  }
}
