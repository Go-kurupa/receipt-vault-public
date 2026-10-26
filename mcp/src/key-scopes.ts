/** Same "active" rule as auth.ts (revokedAt == null). Returns null unless exactly one active key matches. */
export function selectActiveKey<T extends { data: () => Record<string, unknown> | undefined }>(docs: readonly T[]): T | null {
  const active = docs.filter((doc) => doc.data()?.revokedAt == null);
  return active.length === 1 ? active[0]! : null;
}
