import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { ArtifactStore } from "../../ports/artifacts.js";

/**
 * Filesystem artifact byte store — the local-dev counterpart to Azure Blob.
 * Bytes live under `PORTICO_ARTIFACT_DIR` (default `.data/artifacts`), so they
 * survive restarts without any cloud account.
 */
export class FilesystemArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  /**
   * Refs are server-generated, but they are still joined into a filesystem path,
   * so confine them to the root rather than trusting that invariant.
   */
  private pathFor(ref: string): string {
    const full = resolve(join(this.root, ref));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`artifact ref escapes the artifact directory: '${ref}'`);
    }
    return full;
  }

  async put(ref: string, body: Buffer): Promise<void> {
    const path = this.pathFor(ref);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(ref: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(ref));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(ref: string): Promise<void> {
    await rm(this.pathFor(ref), { force: true });
  }
}
