import { randomUUID, createHash } from "node:crypto";
import type {
  ArtifactMeta,
  ArtifactMetaStore,
  ArtifactStore,
  ArtifactVisibility,
} from "../ports/artifacts.js";
import type { User } from "../ports/identity.js";
import { ArtifactForbiddenError, ArtifactNotFoundError } from "../domain/errors.js";

const CONTENT_TYPE = "text/html; charset=utf-8";

export interface PublishInput {
  html: string;
  title?: string;
  visibility?: ArtifactVisibility;
  expiresInSeconds?: number;
}

export interface ArtifactsDeps {
  store: ArtifactStore;
  meta: ArtifactMetaStore;
  baseUrl: string;
}

/**
 * HTML artifact host use-cases. Publish stores bytes in blob storage + a
 * metadata row and returns a login-gated URL. View enforces visibility
 * (`authenticated` = any signed-in omni user; `private` = owner only) and treats
 * revoked/expired artifacts as not found.
 */
export class ArtifactsService {
  constructor(private readonly deps: ArtifactsDeps) {}

  url(id: string): string {
    return `${this.deps.baseUrl}/a/${id}`;
  }

  async publish(user: User, input: PublishInput): Promise<{ id: string; url: string }> {
    const id = randomUUID();
    const ref = `${id}.html`;
    const body = Buffer.from(input.html, "utf8");
    await this.deps.store.put(ref, body, CONTENT_TYPE);
    await this.deps.meta.create({
      id,
      ownerUserId: user.id,
      title: input.title ?? null,
      storageRef: ref,
      contentHash: createHash("sha256").update(body).digest("hex"),
      visibility: input.visibility ?? "authenticated",
      createdAt: new Date(),
      expiresAt: input.expiresInSeconds
        ? new Date(Date.now() + input.expiresInSeconds * 1000)
        : null,
      revokedAt: null,
    });
    return { id, url: this.url(id) };
  }

  /** Returns the HTML bytes + metadata, enforcing visibility. Throws otherwise. */
  async view(viewerUserId: string, id: string): Promise<{ html: Buffer; meta: ArtifactMeta }> {
    const meta = await this.deps.meta.get(id);
    if (!meta || meta.revokedAt) throw new ArtifactNotFoundError();
    if (meta.expiresAt && meta.expiresAt.getTime() <= Date.now()) throw new ArtifactNotFoundError();
    if (meta.visibility === "private" && meta.ownerUserId !== viewerUserId) {
      throw new ArtifactForbiddenError();
    }
    const html = await this.deps.store.get(meta.storageRef);
    if (!html) throw new ArtifactNotFoundError();
    return { html, meta };
  }

  async list(user: User): Promise<ArtifactMeta[]> {
    return this.deps.meta.listByOwner(user.id);
  }

  async revoke(user: User, id: string): Promise<boolean> {
    const meta = await this.deps.meta.get(id);
    if (!meta || meta.ownerUserId !== user.id) return false;
    await this.deps.meta.markRevoked(id, new Date());
    await this.deps.store.delete(meta.storageRef);
    return true;
  }
}
