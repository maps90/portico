import type { Pool } from "pg";
import type { TokenStore, UserStore } from "../ports/identity.js";
import { InMemoryUserStore } from "./memory/user-store.js";
import { InMemoryTokenStore } from "./memory/token-store.js";
import { PostgresUserStore } from "./db/postgres-user-store.js";
import { PostgresTokenStore } from "./db/postgres-token-store.js";

/**
 * Bundle of persistence adapters. Grows per milestone (connections, artifacts).
 * `buildStores` picks Postgres when a pool is provided, else in-memory — so the
 * two are proven against the same application/behaviour tests, mirroring jean.
 */
export interface Stores {
  users: UserStore;
  tokens: TokenStore;
}

export function buildStores(pool: Pool | null): Stores {
  if (pool) {
    return {
      users: new PostgresUserStore(pool),
      tokens: new PostgresTokenStore(pool),
    };
  }
  const users = new InMemoryUserStore();
  return { users, tokens: new InMemoryTokenStore(users) };
}
