import type { Pool } from "pg";
import type { TokenStore, UserStore } from "../ports/identity.js";
import type { ConnectionVault } from "../ports/connections.js";
import type { OAuthStateStore } from "../ports/oauth.js";
import type { ArtifactMetaStore, ArtifactStore } from "../ports/artifacts.js";
import { InMemoryUserStore } from "./memory/user-store.js";
import { InMemoryTokenStore } from "./memory/token-store.js";
import { InMemoryConnectionVault } from "./memory/connection-vault.js";
import { InMemoryOAuthStateStore } from "./memory/oauth-state-store.js";
import { InMemoryArtifactStore } from "./memory/artifact-store.js";
import { InMemoryArtifactMetaStore } from "./memory/artifact-meta-store.js";
import { PostgresUserStore } from "./db/postgres-user-store.js";
import { PostgresTokenStore } from "./db/postgres-token-store.js";
import { PostgresConnectionVault } from "./db/postgres-connection-vault.js";
import { PostgresOAuthStateStore } from "./db/postgres-oauth-state-store.js";
import { PostgresArtifactMetaStore } from "./db/postgres-artifact-meta-store.js";
import { AzureBlobArtifactStore, type AzureBlobConfig } from "./blob/azure-blob-store.js";
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
  artifactMeta: ArtifactMetaStore;
  artifactStore: ArtifactStore;
}

export interface StoreOptions {
  encryptionKey: Buffer;
  artifact: AzureBlobConfig;
}

export function buildStores(pool: Pool | null, opts: StoreOptions): Stores {
  if (pool) {
    return {
      users: new PostgresUserStore(pool),
      tokens: new PostgresTokenStore(pool),
      vault: new PostgresConnectionVault(pool, new AesGcmCrypto(opts.encryptionKey)),
      oauthState: new PostgresOAuthStateStore(pool),
      artifactMeta: new PostgresArtifactMetaStore(pool),
      artifactStore: new AzureBlobArtifactStore(opts.artifact),
    };
  }
  const users = new InMemoryUserStore();
  return {
    users,
    tokens: new InMemoryTokenStore(users),
    vault: new InMemoryConnectionVault(),
    oauthState: new InMemoryOAuthStateStore(),
    artifactMeta: new InMemoryArtifactMetaStore(),
    artifactStore: new InMemoryArtifactStore(),
  };
}
