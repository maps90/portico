import type { Pool } from "pg";
import type { User, UserStore } from "../../ports/identity.js";

interface UserRow {
  id: string;
  issuer: string;
  subject: string;
  email: string | null;
  created_at: Date;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  issuer: r.issuer,
  subject: r.subject,
  email: r.email,
  createdAt: r.created_at,
});

export class PostgresUserStore implements UserStore {
  constructor(private readonly pool: Pool) {}

  async upsertByIdentity(input: {
    issuer: string;
    subject: string;
    email: string | null;
  }): Promise<User> {
    const { rows } = await this.pool.query<UserRow>(
      `INSERT INTO users (issuer, subject, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (issuer, subject)
       DO UPDATE SET email = EXCLUDED.email
       RETURNING id, issuer, subject, email, created_at`,
      [input.issuer, input.subject, input.email],
    );
    return toUser(rows[0]!);
  }

  async getById(id: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT id, issuer, subject, email, created_at FROM users WHERE id = $1`,
      [id],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }
}
