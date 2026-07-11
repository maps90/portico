import type { Pool } from "pg";
import type {
  Connection,
  ConnectionStatus,
  ConnectionVault,
} from "../../ports/connections.js";
import type { AesGcmCrypto } from "../crypto/aesgcm.js";

interface ConnRow {
  user_id: string;
  upstream_id: string;
  access_token_enc: string;
  refresh_token_enc: string | null;
  expires_at: Date | null;
  scopes: string[];
  status: string;
}

/** Postgres ConnectionVault; access/refresh tokens are AES-256-GCM encrypted. */
export class PostgresConnectionVault implements ConnectionVault {
  constructor(
    private readonly pool: Pool,
    private readonly crypto: AesGcmCrypto,
  ) {}

  private toConn(r: ConnRow): Connection {
    return {
      userId: r.user_id,
      upstreamId: r.upstream_id,
      accessToken: this.crypto.decrypt(r.access_token_enc),
      refreshToken: r.refresh_token_enc ? this.crypto.decrypt(r.refresh_token_enc) : null,
      expiresAt: r.expires_at,
      scopes: r.scopes,
      status: r.status as ConnectionStatus,
    };
  }

  async put(conn: Connection): Promise<void> {
    await this.pool.query(
      `INSERT INTO connections
         (user_id, upstream_id, access_token_enc, refresh_token_enc, expires_at, scopes, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (user_id, upstream_id) DO UPDATE SET
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         expires_at = EXCLUDED.expires_at,
         scopes = EXCLUDED.scopes,
         status = EXCLUDED.status,
         updated_at = now()`,
      [
        conn.userId,
        conn.upstreamId,
        this.crypto.encrypt(conn.accessToken),
        conn.refreshToken ? this.crypto.encrypt(conn.refreshToken) : null,
        conn.expiresAt,
        conn.scopes,
        conn.status,
      ],
    );
  }

  async get(userId: string, upstreamId: string): Promise<Connection | null> {
    const { rows } = await this.pool.query<ConnRow>(
      `SELECT user_id, upstream_id, access_token_enc, refresh_token_enc, expires_at, scopes, status
       FROM connections WHERE user_id = $1 AND upstream_id = $2`,
      [userId, upstreamId],
    );
    return rows[0] ? this.toConn(rows[0]) : null;
  }

  async list(userId: string): Promise<Connection[]> {
    const { rows } = await this.pool.query<ConnRow>(
      `SELECT user_id, upstream_id, access_token_enc, refresh_token_enc, expires_at, scopes, status
       FROM connections WHERE user_id = $1 ORDER BY upstream_id`,
      [userId],
    );
    return rows.map((r) => this.toConn(r));
  }

  async delete(userId: string, upstreamId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM connections WHERE user_id = $1 AND upstream_id = $2`,
      [userId, upstreamId],
    );
  }
}
