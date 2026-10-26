// テスト専用の小さな Firestore もどき（本番コードからは import しない）。
// doc / collection.where().get / runTransaction（読み → 書きの順・create は既存なら失敗）を再現する。
type Row = Record<string, unknown>;

export function fakeFirestore(seed: Record<string, Row> = {}) {
  const rows = new Map<string, Row>(Object.entries(seed));
  const snap = (path: string) => ({ id: path.split('/').pop()!, exists: rows.has(path), data: () => rows.get(path), ref: docRef(path) });
  const write = (path: string, kind: 'create' | 'set' | 'update', data: Row) => {
    if (kind === 'create' && rows.has(path)) throw new Error(`already exists: ${path}`);
    if (kind === 'update' && !rows.has(path)) throw new Error(`not found: ${path}`);
    rows.set(path, kind === 'update' ? { ...rows.get(path), ...data } : data);
  };
  function docRef(path: string) {
    return {
      path,
      id: path.split('/').pop()!,
      get: async () => snap(path),
      create: async (data: Row) => write(path, 'create', data),
      set: async (data: Row) => write(path, 'set', data),
      update: async (data: Row) => write(path, 'update', data),
    };
  }
  function query(name: string, filters: [string, unknown][]) {
    return {
      where: (field: string, _op: string, value: unknown) => query(name, [...filters, [field, value]]),
      get: async () => ({
        docs: [...rows.keys()]
          .filter((p) => p.split('/').length === 2 && p.startsWith(name + '/') && filters.every(([f, v]) => rows.get(p)?.[f] === v))
          .map(snap),
      }),
    };
  }
  const db = {
    doc: docRef,
    collection: (name: string) => ({ ...query(name, []), doc: (id: string) => docRef(`${name}/${id}`) }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      const staged: [string, 'create' | 'set' | 'update', Row][] = [];
      const result = await fn({
        get: async (target: { path?: string; get: () => Promise<unknown> }) => {
          if (staged.length) throw new Error('read after write in transaction');
          return target.get();
        },
        create: (r: { path: string }, d: Row) => staged.push([r.path, 'create', d]),
        set: (r: { path: string }, d: Row) => staged.push([r.path, 'set', d]),
        update: (r: { path: string }, d: Row) => staged.push([r.path, 'update', d]),
      });
      const before = new Map(rows);
      try {
        for (const [p, k, d] of staged) write(p, k, d);
      } catch (e) {
        rows.clear();
        for (const [k, v] of before) rows.set(k, v);
        throw e;
      }
      return result;
    },
  };
  return { db: db as unknown as import('firebase-admin/firestore').Firestore, rows };
}
