import type { OAuthState, OAuthStateStore } from "../../ports/oauth.js";

/** In-memory OAuthStateStore; `take` consumes the entry once. */
export class InMemoryOAuthStateStore implements OAuthStateStore {
  private readonly byState = new Map<string, OAuthState>();

  async put(s: OAuthState): Promise<void> {
    this.byState.set(s.state, s);
  }

  async take(state: string): Promise<OAuthState | null> {
    const found = this.byState.get(state) ?? null;
    if (found) this.byState.delete(state);
    return found;
  }
}
