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
  /**
   * Where the portal is served from. Defaults to the base URL. Only differs in
   * `make dev`, where Vite hosts the portal on its own port and proxies the API
   * back here — so post-login/post-connect pages must send the browser there.
   */
  PORTICO_PORTAL_URL: z.string().url().optional(),
  // Optional: when unset, portico runs with in-memory stores (single-process
  // dev / tests). Provide a URL to use Postgres.
  PORTICO_DATABASE_URL: z.string().min(1).optional(),
  PORTICO_ENCRYPTION_KEY: base64Key(32),
  PORTICO_SESSION_SECRET: z.string().min(16),

  PORTICO_GOOGLE_CLIENT_ID: z
    .string()
    .min(1, "required — create a Google OAuth client (Web application); see .env.example"),
  PORTICO_GOOGLE_CLIENT_SECRET: z
    .string()
    .min(1, "required — the secret for that same Google OAuth client"),
  /**
   * Comma-separated Workspace domains allowed to sign in, or the literal `*` to
   * allow any verified Google account.
   *
   * Required, and there is no default: this is the only thing standing between a
   * deployment and "any Google account on earth gets a bearer token". An optional
   * value that defaults to open means deleting one line of config silently opens
   * the instance, and nothing — no lint, no test — would catch it. Making the open
   * case say `*` out loud forces that to be a decision someone wrote down.
   */
  PORTICO_ALLOWED_DOMAINS: z
    .string()
    .min(1, 'required — a domain list like "okadoc.com", or "*" to allow any Google account'),

  // Artifacts: Azure Blob when an account is set, else the local filesystem.
  PORTICO_ARTIFACT_DIR: z.string().min(1).default(".data/artifacts"),
  PORTICO_ARTIFACT_BLOB_ACCOUNT: z.string().optional(),
  PORTICO_ARTIFACT_CONTAINER: z.string().min(1).default("portico-artifacts"),
  PORTICO_ARTIFACT_BLOB_CONNECTION_STRING: z.string().optional(),
});

/** Where artifact bytes live. Azure Blob in production, disk locally. */
export type ArtifactSettings =
  | { kind: "azure-blob"; blobAccount: string; container: string; connectionString?: string }
  | { kind: "filesystem"; dir: string };

export interface Settings {
  baseUrl: string;
  /** Origin the portal is served from; equals baseUrl outside `make dev`. */
  portalUrl: string;
  port: number;
  /** When undefined, in-memory stores are used (single-process dev / tests). */
  databaseUrl?: string;
  /** 32-byte key for AES-256-GCM upstream-token encryption. */
  encryptionKey: Buffer;
  sessionSecret: string;
  google: {
    clientId: string;
    clientSecret: string;
  };
  /** Workspace domains allowed to sign in. Empty = any verified Google account. */
  allowedDomains: string[];
  artifact: ArtifactSettings;
}

const parseDomains = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);

export function loadConfig(env: Record<string, string | undefined>): Settings {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid portico configuration:\n${issues}`);
  }
  const e = parsed.data;

  const artifact: ArtifactSettings = e.PORTICO_ARTIFACT_BLOB_ACCOUNT
    ? {
        kind: "azure-blob",
        blobAccount: e.PORTICO_ARTIFACT_BLOB_ACCOUNT,
        container: e.PORTICO_ARTIFACT_CONTAINER,
        ...(e.PORTICO_ARTIFACT_BLOB_CONNECTION_STRING
          ? { connectionString: e.PORTICO_ARTIFACT_BLOB_CONNECTION_STRING }
          : {}),
      }
    : { kind: "filesystem", dir: e.PORTICO_ARTIFACT_DIR };

  const baseUrl = e.PORTICO_BASE_URL.replace(/\/$/, "");

  return {
    baseUrl,
    portalUrl: (e.PORTICO_PORTAL_URL ?? baseUrl).replace(/\/$/, ""),
    port: e.PORTICO_PORT,
    ...(e.PORTICO_DATABASE_URL ? { databaseUrl: e.PORTICO_DATABASE_URL } : {}),
    encryptionKey: Buffer.from(e.PORTICO_ENCRYPTION_KEY, "base64"),
    sessionSecret: e.PORTICO_SESSION_SECRET,
    google: {
      clientId: e.PORTICO_GOOGLE_CLIENT_ID,
      clientSecret: e.PORTICO_GOOGLE_CLIENT_SECRET,
    },
    allowedDomains: parseDomains(e.PORTICO_ALLOWED_DOMAINS),
    artifact,
  };
}
