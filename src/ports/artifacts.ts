/** Artifact ports: blob storage for bytes + metadata rows. */

export type ArtifactVisibility = "authenticated" | "private";

export interface ArtifactMeta {
  id: string;
  ownerUserId: string;
  title: string | null;
  storageRef: string;
  contentHash: string;
  visibility: ArtifactVisibility;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/** Blob storage for artifact bytes (Azure Blob in prod). */
export interface ArtifactStore {
  put(ref: string, body: Buffer, contentType: string): Promise<void>;
  get(ref: string): Promise<Buffer | null>;
  delete(ref: string): Promise<void>;
}

/** Metadata rows for published artifacts. */
export interface ArtifactMetaStore {
  create(meta: ArtifactMeta): Promise<void>;
  get(id: string): Promise<ArtifactMeta | null>;
  listByOwner(ownerUserId: string): Promise<ArtifactMeta[]>;
  markRevoked(id: string, at: Date): Promise<void>;
}
