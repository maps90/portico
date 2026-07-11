import { describe, it, expect, beforeEach } from "vitest";
import { ArtifactsService } from "./artifacts-service.js";
import { InMemoryArtifactStore } from "../adapters/memory/artifact-store.js";
import { InMemoryArtifactMetaStore } from "../adapters/memory/artifact-meta-store.js";
import { ArtifactForbiddenError, ArtifactNotFoundError } from "../domain/errors.js";
import type { User } from "../ports/identity.js";

const owner: User = { id: "owner", issuer: "i", subject: "s", email: null, createdAt: new Date() };
const other: User = { id: "other", issuer: "i", subject: "s2", email: null, createdAt: new Date() };

describe("ArtifactsService", () => {
  let store: InMemoryArtifactStore;
  let meta: InMemoryArtifactMetaStore;
  let svc: ArtifactsService;

  beforeEach(() => {
    store = new InMemoryArtifactStore();
    meta = new InMemoryArtifactMetaStore();
    svc = new ArtifactsService({ store, meta, baseUrl: "https://portico.okadoc.com" });
  });

  it("publishes and returns a viewable URL, storing the bytes", async () => {
    const { id, url } = await svc.publish(owner, { html: "<h1>Report</h1>", title: "Q3" });
    expect(url).toBe(`https://portico.okadoc.com/a/${id}`);
    const { html, meta: m } = await svc.view(owner.id, id);
    expect(html.toString("utf8")).toBe("<h1>Report</h1>");
    expect(m.title).toBe("Q3");
  });

  it("lets any authenticated user view an 'authenticated' artifact", async () => {
    const { id } = await svc.publish(owner, { html: "<p>hi</p>" });
    const { html } = await svc.view(other.id, id);
    expect(html.toString("utf8")).toBe("<p>hi</p>");
  });

  it("restricts a 'private' artifact to its owner", async () => {
    const { id } = await svc.publish(owner, { html: "<p>secret</p>", visibility: "private" });
    await expect(svc.view(other.id, id)).rejects.toBeInstanceOf(ArtifactForbiddenError);
    await expect(svc.view(owner.id, id)).resolves.toBeTruthy();
  });

  it("treats a revoked artifact as not found and removes its bytes", async () => {
    const { id } = await svc.publish(owner, { html: "<p>x</p>" });
    expect(await svc.revoke(owner, id)).toBe(true);
    await expect(svc.view(owner.id, id)).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  it("does not let a non-owner revoke", async () => {
    const { id } = await svc.publish(owner, { html: "<p>x</p>" });
    expect(await svc.revoke(other, id)).toBe(false);
    await expect(svc.view(owner.id, id)).resolves.toBeTruthy();
  });

  it("treats an expired artifact as not found", async () => {
    const { id } = await svc.publish(owner, { html: "<p>x</p>", expiresInSeconds: -1 });
    await expect(svc.view(owner.id, id)).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  it("lists the owner's artifacts only", async () => {
    await svc.publish(owner, { html: "<p>a</p>" });
    await svc.publish(other, { html: "<p>b</p>" });
    const list = await svc.list(owner);
    expect(list).toHaveLength(1);
  });
});
