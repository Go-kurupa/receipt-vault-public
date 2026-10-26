export const RATE_LIMIT_MESSAGE = '呼び出し回数の上限です。1分ほど待ってから再度お試しください';
export function createRateLimiter(clock: () => number = Date.now): (keyId: string) => boolean {
  const windows = new Map<string, number[]>();
  let lastSweep = -Infinity;
  return (keyId) => {
    const now = clock();
    // Keep expired keys from accumulating indefinitely in a warm instance.
    if (now - lastSweep >= 60_000) {
      for (const [id, times] of windows)
        if (times[times.length - 1] <= now - 60_000) windows.delete(id);
      lastSweep = now;
    }
    const times = (windows.get(keyId) ?? []).filter((time) => time > now - 60_000);
    windows.set(keyId, times);
    if (times.length >= 60) return false;
    times.push(now);
    return true;
  };
}
export const allowMcpRequest = createRateLimiter();
