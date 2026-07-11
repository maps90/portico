/**
 * Tool namespacing. Upstream tools are re-exposed as `<prefix>__<name>` so tools
 * from different services never collide and calls can be routed back. Pure
 * functions — used by the aggregator, the router, and the omni management tools.
 */

const SEP = "__";

export function namespaceTool(prefix: string, name: string): string {
  return `${prefix}${SEP}${name}`;
}

/** Splits `prefix__name`; returns null if it isn't a namespaced tool. */
export function parseTool(full: string): { prefix: string; name: string } | null {
  const idx = full.indexOf(SEP);
  if (idx <= 0) return null;
  const name = full.slice(idx + SEP.length);
  if (!name) return null;
  return { prefix: full.slice(0, idx), name };
}
