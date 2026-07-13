/**
 * Domain errors — the pure vocabulary the inner layers speak. No I/O, no
 * framework imports. Interface adapters map these to HTTP status codes / MCP
 * tool errors at the boundary.
 */

export class DomainError extends Error {
  constructor(
    message: string,
    /** Stable machine-readable code for boundary mapping. */
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Presented bearer token is missing, unknown, or revoked. */
export class UnauthorizedError extends DomainError {
  constructor(message = "unauthorized") {
    super(message, "unauthorized");
  }
}

/** OIDC identity is valid but its domain is not on this instance's allowlist. */
export class DomainForbiddenError extends DomainError {
  constructor(message = "identity is outside the allowed domains") {
    super(message, "domain_forbidden");
  }
}

/** User has not linked (or has revoked) the requested upstream service. */
export class ConnectionNotFoundError extends DomainError {
  constructor(readonly upstreamId: string) {
    super(`no active connection for upstream '${upstreamId}'`, "connection_not_found");
  }
}

/** An upstream MCP server could not be reached or refused the call. */
export class UpstreamUnavailableError extends DomainError {
  constructor(
    readonly upstreamId: string,
    message = `upstream '${upstreamId}' unavailable`,
  ) {
    super(message, "upstream_unavailable");
  }
}

export class ArtifactNotFoundError extends DomainError {
  constructor() {
    super("artifact not found", "artifact_not_found");
  }
}

/** Viewer is authenticated but not permitted to see this artifact. */
export class ArtifactForbiddenError extends DomainError {
  constructor() {
    super("not permitted to view this artifact", "artifact_forbidden");
  }
}
