import type { ArtifactStore } from "../../ports/artifacts.js";

/** In-memory artifact byte store for dev/tests. */
export class InMemoryArtifactStore implements ArtifactStore {
  private readonly blobs = new Map<string, Buffer>();

  async put(ref: string, body: Buffer): Promise<void> {
    this.blobs.set(ref, body);
  }

  async get(ref: string): Promise<Buffer | null> {
    return this.blobs.get(ref) ?? null;
  }

  async delete(ref: string): Promise<void> {
    this.blobs.delete(ref);
  }
}
