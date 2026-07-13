import type { Pool } from "pg";
import type { TokenStore, TokenSummary, User } from "../../ports/identity.js";
import { generateBearerToken, hashToken } from "../crypto/tokens.js";
import { PostgresUserStore } from "./postgres-user-store.js";

export class PostgresTokenStore implements TokenStore {
  private readonly users: PostgresUserStore;

  constructor(private readonly pool: Pool) {
    this.users = new PostgresUserStore(pool);
  }

  async mint(userId: string, name: string): Promise<{ token: string }> {
    const token = generateBearerToken();
    await this.pool.query(
      `INSERT INTO tokens (user_id, token_hash, name) VALUES ($1, $2, $3)`,
      [userId, hashToken(token), name],
    );
    return { token };
  }

  async resolve(rawToken: string): Promise<User | null> {
    const { rows } = await this.pool.query<{ user_id: string }>(
      `UPDATE tokens SET last_used_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL
       RETURNING user_id`,
      [hashToken(rawToken)],
    );
    const userId = rows[0]?.user_id;
    return userId ? this.users.getById(userId) : null;
  }

  async revoke(rawToken: string): Promise<void> {
    await this.pool.query(
      `UPDATE tokens SET revoked_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(rawToken)],
    );
  }

  async listActive(userId: string): Promise<TokenSummary[]> {
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      created_at: Date;
      last_used_at: Date | null;
    }>(
      `SELECT id, name, created_at, last_used_at FROM tokens
       WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE tokens SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }
}
