import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const key = Buffer.alloc(32, 7).toString("base64");

const valid: Record<string, string> = {
  PORTICO_BASE_URL: "https://portico.okadoc.com/",
  PORTICO_DATABASE_URL: "postgresql://portico:portico@localhost:5432/portico",
  PORTICO_ENCRYPTION_KEY: key,
  PORTICO_SESSION_SECRET: "a-sufficiently-long-secret",
  PORTICO_ENTRA_TENANT_ID: "tenant",
  PORTICO_ENTRA_CLIENT_ID: "client",
  PORTICO_ENTRA_CLIENT_SECRET: "secret",
  PORTICO_ARTIFACT_BLOB_ACCOUNT: "okadocblob",
};

describe("loadConfig", () => {
  it("parses a valid environment and strips a trailing slash from baseUrl", () => {
    const s = loadConfig(valid);
    expect(s.baseUrl).toBe("https://portico.okadoc.com");
    expect(s.port).toBe(8080);
    expect(s.encryptionKey).toHaveLength(32);
    expect(s.entra.tenantId).toBe("tenant");
    expect(s.artifact.container).toBe("portico-artifacts");
    expect(s.artifact.connectionString).toBeUndefined();
  });

  it("rejects an encryption key that is not 32 bytes", () => {
    expect(() =>
      loadConfig({ ...valid, PORTICO_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/PORTICO_ENCRYPTION_KEY/);
  });

  it("rejects a missing required field", () => {
    const { PORTICO_ENTRA_TENANT_ID: _omit, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/PORTICO_ENTRA_TENANT_ID/);
  });

  it("coerces PORTICO_PORT and keeps an explicit connection string", () => {
    const s = loadConfig({
      ...valid,
      PORTICO_PORT: "9090",
      PORTICO_ARTIFACT_BLOB_CONNECTION_STRING: "DefaultEndpointsProtocol=https;...",
    });
    expect(s.port).toBe(9090);
    expect(s.artifact.connectionString).toContain("DefaultEndpointsProtocol");
  });
});
