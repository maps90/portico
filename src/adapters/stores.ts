import type { Pool } from "pg";
import type { TokenStore, UserStore } from "../ports/identity.js";
import type { ConnectionVault } from "../ports/connections.js";
import type { OAuthStateStore } from "../ports/oauth.js";
import { InMemoryUserStore } from "./memory/user-store.js";
import { InMemoryTokenStore } from "./memory/token-store.js";
import { InMemoryConnectionVault } from "./memory/connection-vault.js";
import { InMemoryOAuthStateStore } from "./memory/oauth-state-store.js";
import { PostgresUserStore } from "./db/postgres-user-store.js";
import { PostgresTokenStore } from "./db/postgres-token-store.js";
import { PostgresConnectionVault } from "./db/postgres-connection-vault.js";
import { PostgresOAuthStateStore } from "./db/postgres-oauth-state-store.js";
import { AesGcmCrypto } from "./crypto/aesgcm.js";

/**
 * Bundle of persistence adapters. `buildStores` picks Postgres when a pool is
 * provided, else in-memory — so the two are proven against the same
 * application/behaviour tests, mirroring jean.
 */
export interface Stores {
  users: UserStore;
  tokens: TokenStore;
  vault: ConnectionVault;
  oauthState: OAuthStateStore;
}

export function buildStores(pool: Pool | null, opts: { encryptionKey: Buffer }): Stores {
  if (pool) {
    return {
      users: new PostgresUserStore(pool),
      tokens: new PostgresTokenStore(pool),
      vault: new PostgresConnectionVault(pool, new AesGcmCrypto(opts.encryptionKey)),
      oauthState: new PostgresOAuthStateStore(pool),
    };
  }
  const users = new InMemoryUserStore();
  return {
    users,
    tokens: new InMemoryTokenStore(users),
    vault: new InMemoryConnectionVault(),
    oauthState: new InMemoryOAuthStateStore(),
  };
}
