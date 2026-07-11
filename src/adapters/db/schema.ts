import type { Pool } from "pg";

/**
 * Idempotent schema creation, run at boot (mirrors jean's boot-time DDL). Holds
 * the full schema for every milestone so later adapters can assume their tables
 * exist: users, tokens, connections, oauth_state, artifacts.
 */
export async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      issuer      TEXT NOT NULL,
      subject     TEXT NOT NULL,
      email       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (issuer, subject)
    );

    CREATE TABLE IF NOT EXISTS tokens (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash    TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at  TIMESTAMPTZ,
      revoked_at    TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS connections (
      user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      upstream_id        TEXT NOT NULL,
      access_token_enc   TEXT NOT NULL,
      refresh_token_enc  TEXT,
      expires_at         TIMESTAMPTZ,
      scopes             TEXT[] NOT NULL DEFAULT '{}',
      status             TEXT NOT NULL DEFAULT 'active',
      connected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, upstream_id)
    );

    CREATE TABLE IF NOT EXISTS oauth_state (
      state          TEXT PRIMARY KEY,
      user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      upstream_id    TEXT NOT NULL,
      pkce_verifier  TEXT NOT NULL,
      redirect       TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title          TEXT,
      storage_ref    TEXT NOT NULL,
      content_hash   TEXT NOT NULL,
      visibility     TEXT NOT NULL DEFAULT 'authenticated',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at     TIMESTAMPTZ,
      revoked_at     TIMESTAMPTZ
    );
  `);
}
