export const PRE_AUTH_LIMIT_MESSAGE = '混み合っています。1分ほど待ってから再度お試しください';

export function createPreAuthLimiter(clock: () => number = Date.now) {
  let requests: number[] = [];
  let failures: number[] = [];
  const knownGood = new Map<string, number>();
  const prune = (now: number) => {
    requests = requests.filter((time) => time > now - 60_000);
    failures = failures.filter((time) => time > now - 60_000);
    for (const [id, authenticatedAt] of knownGood)
      if (authenticatedAt <= now - 600_000) knownGood.delete(id);
  };
  return {
    allow(keyId: string | null): boolean {
      const now = clock();
      prune(now);
      if (requests.length >= 120) return false;
      requests.push(now);
      return failures.length <= 30 || (keyId !== null && knownGood.has(keyId));
    },
    recordFailure(): void {
      const now = clock();
      prune(now);
      failures.push(now);
      // The newest 31 failures suffice to determine whether the threshold is exceeded.
      if (failures.length > 31) failures.shift();
    },
    recordSuccess(keyId: string): void {
      const now = clock();
      prune(now);
      knownGood.delete(keyId);
      knownGood.set(keyId, now);
      if (knownGood.size > 16) {
        const oldest = knownGood.keys().next().value;
        if (oldest !== undefined) knownGood.delete(oldest);
      }
    },
    // Counts only, for verifying bounds without exposing key material.
    sizes() {
      prune(clock());
      return { requests: requests.length, failures: failures.length, knownGood: knownGood.size };
    },
  };
}

export const preAuthLimiter = createPreAuthLimiter();
