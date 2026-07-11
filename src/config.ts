import { z } from "zod";

/**
 * Typed configuration for omni-mcp, parsed from `OMNI_*` environment variables.
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
  OMNI_BASE_URL: z.string().url(),
  OMNI_PORT: z.coerce.number().int().positive().default(8080),
  // Optional: when unset, omni-mcp runs with in-memory stores (single-process
  // dev / tests). Provide a URL to use Azure Database for PostgreSQL.
  OMNI_DATABASE_URL: z.string().min(1).optional(),
  OMNI_ENCRYPTION_KEY: base64Key(32),
  OMNI_SESSION_SECRET: z.string().min(16),

  OMNI_ENTRA_TENANT_ID: z.string().min(1),
  OMNI_ENTRA_CLIENT_ID: z.string().min(1),
  OMNI_ENTRA_CLIENT_SECRET: z.string().min(1),

  OMNI_ARTIFACT_BLOB_ACCOUNT: z.string().min(1),
  OMNI_ARTIFACT_CONTAINER: z.string().min(1).default("omni-artifacts"),
  OMNI_ARTIFACT_BLOB_CONNECTION_STRING: z.string().optional(),
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
    throw new Error(`Invalid omni-mcp configuration:\n${issues}`);
  }
  const e = parsed.data;
  return {
    baseUrl: e.OMNI_BASE_URL.replace(/\/$/, ""),
    port: e.OMNI_PORT,
    ...(e.OMNI_DATABASE_URL ? { databaseUrl: e.OMNI_DATABASE_URL } : {}),
    encryptionKey: Buffer.from(e.OMNI_ENCRYPTION_KEY, "base64"),
    sessionSecret: e.OMNI_SESSION_SECRET,
    entra: {
      tenantId: e.OMNI_ENTRA_TENANT_ID,
      clientId: e.OMNI_ENTRA_CLIENT_ID,
      clientSecret: e.OMNI_ENTRA_CLIENT_SECRET,
    },
    artifact: {
      blobAccount: e.OMNI_ARTIFACT_BLOB_ACCOUNT,
      container: e.OMNI_ARTIFACT_CONTAINER,
      ...(e.OMNI_ARTIFACT_BLOB_CONNECTION_STRING
        ? { connectionString: e.OMNI_ARTIFACT_BLOB_CONNECTION_STRING }
        : {}),
    },
  };
}
