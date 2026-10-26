import { groupChains, toRecord, type Chain, type ReceiptRecord } from './receipts-pure';

export interface Snapshot { chains: Chain[]; brokenChainIds: ReadonlySet<string>; skipped: number; asOf: string; latestRegisteredAt: string | null }
export type Loader = () => Promise<{ docId: string; data: Record<string, unknown> }[]>;
const TTL_MS = 60_000;

export function createSnapshotSource(load: Loader, clock: () => number = Date.now): () => Promise<Snapshot> {
  let cached: { at: number; value: Promise<Snapshot> } | null = null;
  return () => {
    const now = clock();
    if (cached && now - cached.at < TTL_MS) return cached.value;
    const value = load().then((rows) => {
      const records: ReceiptRecord[] = [];
      // 壊れた行の (chainId, version)。version が読めなければ最新とみなす（旧版を最新扱いしないため）。
      const broken: { chainId: string | null; version: number }[] = [];
      for (const { docId, data } of rows) {
        const r = toRecord(docId, data);
        if (r) records.push(r);
        else
          broken.push({
            chainId: typeof data.chainId === 'string' && data.chainId ? data.chainId : null,
            version: typeof data.version === 'number' && Number.isInteger(data.version) ? data.version : Infinity,
          });
      }
      const skipped = broken.length;
      // 最新版が壊れている領収書は、古い版へ戻さず丸ごと除外する（削除済みの復活・訂正前の値の表示を防ぐ）。
      const brokenChainIds = new Set<string>();
      const chains = groupChains(records).filter((c) => {
        const hidden = broken.some((b) => b.chainId === c.chainId && b.version >= c.latest.version);
        if (hidden) brokenChainIds.add(c.chainId);
        return !hidden;
      });
      const latestRegisteredAt = records.reduce<string | null>((m, r) => (r.registeredAt && (!m || r.registeredAt > m) ? r.registeredAt : m), null);
      return { chains, brokenChainIds, skipped, asOf: new Date(clock()).toISOString(), latestRegisteredAt };
    });
    value.catch(() => { if (cached?.value === value) cached = null; }); // 失敗をキャッシュしない
    cached = { at: now, value };
    return value;
  };
}

export const getSnapshot = createSnapshotSource(async () => {
  const { db } = await import('./admin');
  const snap = await db.collection('receipts').get();
  return snap.docs.map((d) => ({ docId: d.id, data: d.data() }));
});
