/** Connection ports: the encrypted per-(user, upstream) OAuth token vault. */

export type ConnectionStatus = "active" | "expired" | "revoked";

export interface Connection {
  userId: string;
  upstreamId: string;
  /** Decrypted access token. Adapters encrypt/decrypt at the boundary. */
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
  status: ConnectionStatus;
}

/** Encrypted per-(user, upstream) OAuth token store. */
export interface ConnectionVault {
  put(conn: Connection): Promise<void>;
  get(userId: string, upstreamId: string): Promise<Connection | null>;
  list(userId: string): Promise<Connection[]>;
  delete(userId: string, upstreamId: string): Promise<void>;
}
