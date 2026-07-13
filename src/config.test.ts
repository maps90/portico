import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const key = Buffer.alloc(32, 7).toString("base64");

const valid: Record<string, string> = {
  PORTICO_BASE_URL: "https://portico.okadoc.com/",
  PORTICO_DATABASE_URL: "postgresql://portico:portico@localhost:5432/portico",
  PORTICO_ENCRYPTION_KEY: key,
  PORTICO_SESSION_SECRET: "a-sufficiently-long-secret",
  PORTICO_GOOGLE_CLIENT_ID: "client",
  PORTICO_GOOGLE_CLIENT_SECRET: "secret",
  PORTICO_ALLOWED_DOMAINS: "okadoc.com",
};

describe("loadConfig", () => {
  it("parses a valid environment and strips a trailing slash from baseUrl", () => {
    const s = loadConfig(valid);
    expect(s.baseUrl).toBe("https://portico.okadoc.com");
    expect(s.port).toBe(8080);
    expect(s.encryptionKey).toHaveLength(32);
    expect(s.google.clientId).toBe("client");
    expect(s.allowedDomains).toEqual(["okadoc.com"]);
  });

  it("rejects an encryption key that is not 32 bytes", () => {
    expect(() =>
      loadConfig({ ...valid, PORTICO_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/PORTICO_ENCRYPTION_KEY/);
  });

  it("rejects a missing required field", () => {
    const { PORTICO_GOOGLE_CLIENT_ID: _omit, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/PORTICO_GOOGLE_CLIENT_ID/);
  });

  it("refuses to boot without an explicit access decision", () => {
    // Fail closed: an absent allowlist must not quietly mean "any Google account".
    const { PORTICO_ALLOWED_DOMAINS: _omit, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/PORTICO_ALLOWED_DOMAINS/);
    expect(() => loadConfig({ ...valid, PORTICO_ALLOWED_DOMAINS: "" })).toThrow(
      /PORTICO_ALLOWED_DOMAINS/,
    );
  });

  it("accepts '*' as the explicit open setting", () => {
    expect(loadConfig({ ...valid, PORTICO_ALLOWED_DOMAINS: "*" }).allowedDomains).toEqual(["*"]);
  });

  it("splits, trims, and lower-cases the allowed domains", () => {
    const s = loadConfig({ ...valid, PORTICO_ALLOWED_DOMAINS: " Okadoc.com , example.org ,, " });
    expect(s.allowedDomains).toEqual(["okadoc.com", "example.org"]);
  });

  it("defaults artifacts to the filesystem when no blob account is set", () => {
    const s = loadConfig(valid);
    expect(s.artifact).toEqual({ kind: "filesystem", dir: ".data/artifacts" });
  });

  it("uses Azure Blob when an account is set, keeping an explicit connection string", () => {
    const s = loadConfig({
      ...valid,
      PORTICO_PORT: "9090",
      PORTICO_ARTIFACT_BLOB_ACCOUNT: "okadocblob",
      PORTICO_ARTIFACT_BLOB_CONNECTION_STRING: "DefaultEndpointsProtocol=https;...",
    });
    expect(s.port).toBe(9090);
    expect(s.artifact).toMatchObject({
      kind: "azure-blob",
      blobAccount: "okadocblob",
      container: "portico-artifacts",
    });
  });
});
