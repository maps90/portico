import type { Pool } from "pg";
import type {
  ArtifactMeta,
  ArtifactMetaStore,
  ArtifactVisibility,
} from "../../ports/artifacts.js";

interface Row {
  id: string;
  owner_user_id: string;
  title: string | null;
  storage_ref: string;
  content_hash: string;
  visibility: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

const toMeta = (r: Row): ArtifactMeta => ({
  id: r.id,
  ownerUserId: r.owner_user_id,
  title: r.title,
  storageRef: r.storage_ref,
  contentHash: r.content_hash,
  visibility: r.visibility as ArtifactVisibility,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
});

const COLS =
  "id, owner_user_id, title, storage_ref, content_hash, visibility, created_at, expires_at, revoked_at";

export class PostgresArtifactMetaStore implements ArtifactMetaStore {
  constructor(private readonly pool: Pool) {}

  async create(m: ArtifactMeta): Promise<void> {
    await this.pool.query(
      `INSERT INTO artifacts (${COLS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [m.id, m.ownerUserId, m.title, m.storageRef, m.contentHash, m.visibility, m.createdAt, m.expiresAt, m.revokedAt],
    );
  }

  async get(id: string): Promise<ArtifactMeta | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLS} FROM artifacts WHERE id = $1`,
      [id],
    );
    return rows[0] ? toMeta(rows[0]) : null;
  }

  async listByOwner(ownerUserId: string): Promise<ArtifactMeta[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLS} FROM artifacts WHERE owner_user_id = $1 ORDER BY created_at DESC`,
      [ownerUserId],
    );
    return rows.map(toMeta);
  }

  async markRevoked(id: string, at: Date): Promise<void> {
    await this.pool.query(`UPDATE artifacts SET revoked_at = $2 WHERE id = $1`, [id, at]);
  }
}
