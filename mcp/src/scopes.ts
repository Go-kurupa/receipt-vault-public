export const MCP_SCOPES = ['receipts:read', 'receipts:organize'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
/** Missing, empty, or unknown scopes are rejected (no legacy keys exist). */
export function parseKeyScopes(raw: unknown): McpScope[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const scopes: McpScope[] = [];
  for (const value of raw) {
    const scope = MCP_SCOPES.find((allowed) => allowed === value);
    if (scope === undefined) return null;
    scopes.push(scope);
  }
  return scopes;
}
