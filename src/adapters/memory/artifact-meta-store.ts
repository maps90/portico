import type { ArtifactMeta, ArtifactMetaStore } from "../../ports/artifacts.js";

/** In-memory artifact metadata store for dev/tests. */
export class InMemoryArtifactMetaStore implements ArtifactMetaStore {
  private readonly byId = new Map<string, ArtifactMeta>();

  async create(meta: ArtifactMeta): Promise<void> {
    this.byId.set(meta.id, { ...meta });
  }

  async get(id: string): Promise<ArtifactMeta | null> {
    const m = this.byId.get(id);
    return m ? { ...m } : null;
  }

  async listByOwner(ownerUserId: string): Promise<ArtifactMeta[]> {
    return [...this.byId.values()]
      .filter((m) => m.ownerUserId === ownerUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async markRevoked(id: string, at: Date): Promise<void> {
    const m = this.byId.get(id);
    if (m) m.revokedAt = at;
  }
}
