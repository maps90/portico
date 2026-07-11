import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const key = Buffer.alloc(32, 7).toString("base64");

const valid: Record<string, string> = {
  OMNI_BASE_URL: "https://omni.okadoc.com/",
  OMNI_DATABASE_URL: "postgresql://omni:omni@localhost:5432/omni",
  OMNI_ENCRYPTION_KEY: key,
  OMNI_SESSION_SECRET: "a-sufficiently-long-secret",
  OMNI_ENTRA_TENANT_ID: "tenant",
  OMNI_ENTRA_CLIENT_ID: "client",
  OMNI_ENTRA_CLIENT_SECRET: "secret",
  OMNI_ARTIFACT_BLOB_ACCOUNT: "okadocblob",
};

describe("loadConfig", () => {
  it("parses a valid environment and strips a trailing slash from baseUrl", () => {
    const s = loadConfig(valid);
    expect(s.baseUrl).toBe("https://omni.okadoc.com");
    expect(s.port).toBe(8080);
    expect(s.encryptionKey).toHaveLength(32);
    expect(s.entra.tenantId).toBe("tenant");
    expect(s.artifact.container).toBe("omni-artifacts");
    expect(s.artifact.connectionString).toBeUndefined();
  });

  it("rejects an encryption key that is not 32 bytes", () => {
    expect(() =>
      loadConfig({ ...valid, OMNI_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/OMNI_ENCRYPTION_KEY/);
  });

  it("rejects a missing required field", () => {
    const { OMNI_ENTRA_TENANT_ID: _omit, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/OMNI_ENTRA_TENANT_ID/);
  });

  it("coerces OMNI_PORT and keeps an explicit connection string", () => {
    const s = loadConfig({
      ...valid,
      OMNI_PORT: "9090",
      OMNI_ARTIFACT_BLOB_CONNECTION_STRING: "DefaultEndpointsProtocol=https;...",
    });
    expect(s.port).toBe(9090);
    expect(s.artifact.connectionString).toContain("DefaultEndpointsProtocol");
  });
});
