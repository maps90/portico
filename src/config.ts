import { z } from "zod";

/**
 * Typed configuration for portico, parsed from `PORTICO_*` environment variables.
 *
 * `loadConfig` takes an explicit env record so it can be unit-tested without
 * mutating `process.env`. The composition root calls `loadConfig(process.env)`.
 */

const base64Key = (bytes: number) =>
  z
    .string()
    .min(1, "required")
    .refine(
      (v) => {
        try {
          return Buffer.from(v, "base64").length === bytes;
        } catch {
          return false;
        }
      },
      { message: `must be base64-encoded ${bytes} bytes` },
    );

const schema = z.object({
  PORTICO_BASE_URL: z.string().url(),
  PORTICO_PORT: z.coerce.number().int().positive().default(8080),
  // Optional: when unset, portico runs with in-memory stores (single-process
  // dev / tests). Provide a URL to use Azure Database for PostgreSQL.
  PORTICO_DATABASE_URL: z.string().min(1).optional(),
  PORTICO_ENCRYPTION_KEY: base64Key(32),
  PORTICO_SESSION_SECRET: z.string().min(16),

  PORTICO_ENTRA_TENANT_ID: z.string().min(1),
  PORTICO_ENTRA_CLIENT_ID: z.string().min(1),
  PORTICO_ENTRA_CLIENT_SECRET: z.string().min(1),

  PORTICO_ARTIFACT_BLOB_ACCOUNT: z.string().min(1),
  PORTICO_ARTIFACT_CONTAINER: z.string().min(1).default("portico-artifacts"),
  PORTICO_ARTIFACT_BLOB_CONNECTION_STRING: z.string().optional(),
});

export interface Settings {
  baseUrl: string;
  port: number;
  /** When undefined, in-memory stores are used (single-process dev / tests). */
  databaseUrl?: string;
  /** 32-byte key for AES-256-GCM upstream-token encryption. */
  encryptionKey: Buffer;
  sessionSecret: string;
  entra: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
  };
  artifact: {
    blobAccount: string;
    container: string;
    connectionString?: string;
  };
}

export function loadConfig(env: Record<string, string | undefined>): Settings {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid portico configuration:\n${issues}`);
  }
  const e = parsed.data;
  return {
    baseUrl: e.PORTICO_BASE_URL.replace(/\/$/, ""),
    port: e.PORTICO_PORT,
    ...(e.PORTICO_DATABASE_URL ? { databaseUrl: e.PORTICO_DATABASE_URL } : {}),
    encryptionKey: Buffer.from(e.PORTICO_ENCRYPTION_KEY, "base64"),
    sessionSecret: e.PORTICO_SESSION_SECRET,
    entra: {
      tenantId: e.PORTICO_ENTRA_TENANT_ID,
      clientId: e.PORTICO_ENTRA_CLIENT_ID,
      clientSecret: e.PORTICO_ENTRA_CLIENT_SECRET,
    },
    artifact: {
      blobAccount: e.PORTICO_ARTIFACT_BLOB_ACCOUNT,
      container: e.PORTICO_ARTIFACT_CONTAINER,
      ...(e.PORTICO_ARTIFACT_BLOB_CONNECTION_STRING
        ? { connectionString: e.PORTICO_ARTIFACT_BLOB_CONNECTION_STRING }
        : {}),
    },
  };
}
