import type { Connection, ConnectionVault } from "../../ports/connections.js";

/** In-memory ConnectionVault for single-process runs and tests. */
export class InMemoryConnectionVault implements ConnectionVault {
  private readonly byKey = new Map<string, Connection>();

  private key(userId: string, upstreamId: string): string {
    return `${userId}:${upstreamId}`;
  }

  async put(conn: Connection): Promise<void> {
    this.byKey.set(this.key(conn.userId, conn.upstreamId), { ...conn });
  }

  async get(userId: string, upstreamId: string): Promise<Connection | null> {
    return this.byKey.get(this.key(userId, upstreamId)) ?? null;
  }

  async list(userId: string): Promise<Connection[]> {
    return [...this.byKey.values()].filter((c) => c.userId === userId);
  }

  async delete(userId: string, upstreamId: string): Promise<void> {
    this.byKey.delete(this.key(userId, upstreamId));
  }
}
