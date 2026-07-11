import type { Pool } from "pg";
import type { OAuthState, OAuthStateStore } from "../../ports/oauth.js";

interface StateRow {
  state: string;
  user_id: string;
  upstream_id: string;
  pkce_verifier: string;
  redirect: string | null;
  created_at: Date;
}

/** Postgres OAuthStateStore; `take` deletes-and-returns atomically. */
export class PostgresOAuthStateStore implements OAuthStateStore {
  constructor(private readonly pool: Pool) {}

  async put(s: OAuthState): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_state (state, user_id, upstream_id, pkce_verifier, redirect)
       VALUES ($1, $2, $3, $4, $5)`,
      [s.state, s.userId, s.upstreamId, s.pkceVerifier, s.redirect],
    );
  }

  async take(state: string): Promise<OAuthState | null> {
    const { rows } = await this.pool.query<StateRow>(
      `DELETE FROM oauth_state WHERE state = $1
       RETURNING state, user_id, upstream_id, pkce_verifier, redirect, created_at`,
      [state],
    );
    const r = rows[0];
    return r
      ? {
          state: r.state,
          userId: r.user_id,
          upstreamId: r.upstream_id,
          pkceVerifier: r.pkce_verifier,
          redirect: r.redirect,
          createdAt: r.created_at,
        }
      : null;
  }
}
