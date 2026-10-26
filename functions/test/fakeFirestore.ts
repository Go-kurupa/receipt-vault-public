import type { Firestore, Transaction } from "firebase-admin/firestore";

type Data = Record<string, unknown>;
type Reference = { path: string; id: string; get: () => Promise<ReturnType<typeof snapshot>> };

function snapshot(path: string, data: Data | undefined) {
  return { id: path.split("/").at(-1)!, exists: data !== undefined, data: () => data };
}

class Query {
  chainId = "";
  constructor(readonly collection: string) {}
  where(field: string, operator: string, value: string) {
    if (field !== "chainId" || operator !== "==") throw new Error("Unexpected filter");
    this.chainId = value;
    return this;
  }
  orderBy(field: string, direction: string) {
    if (field !== "version" || direction !== "desc") throw new Error("Unexpected ordering");
    return this;
  }
  limit(count: number) {
    if (count !== 1) throw new Error("Unexpected limit");
    return this;
  }
  get() { throw new Error("最新版はトランザクション内で読み取る必要があります"); }
}

// 読取り競合時の再実行・新規作成の原子性を検査する小さな偽物。実機のロック検証は別途必要。
export class FakeFirestore {
  documents = new Map<string, Data>();
  reads: string[] = [];
  attempts = 0;
  failNextCommit = false;
  private revision = 0;
  private nextId = 0;

  collection(name: string) {
    const query = new Query(name);
    return Object.assign(query, {
      doc: (id = `random-${++this.nextId}`): Reference => {
        const path = `${name}/${id}`;
        return { path, id, get: async () => snapshot(path, this.documents.get(path)) };
      },
    });
  }

  asFirestore(): Firestore { return this as unknown as Firestore; }

  async runTransaction<Result>(callback: (tx: Transaction) => Promise<Result>): Promise<Result> {
    for (let attempt = 0; attempt < 8; attempt++) {
      this.attempts++;
      const initialRevision = this.revision;
      let queried = false;
      const reads = new Map<string, Data | undefined>();
      const pending = new Map<string, Data>();
      const tx = {
        get: async (ref: Reference | Query) => {
          if (pending.size) throw new Error("書込み後の読取りは禁止です");
          if (ref instanceof Query) {
            queried = true;
            this.reads.push(`query:${ref.chainId}`);
            const docs = [...this.documents].filter(([path, data]) => path.startsWith(`${ref.collection}/`) && data.chainId === ref.chainId)
              .sort((a, b) => Number(b[1].version) - Number(a[1].version)).slice(0, 1)
              .map(([path, data]) => snapshot(path, data));
            return { empty: docs.length === 0, docs };
          }
          this.reads.push(ref.path);
          const data = this.documents.get(ref.path);
          reads.set(ref.path, data);
          return snapshot(ref.path, data);
        },
        create: (ref: Reference, data: Data) => { pending.set(ref.path, data); },
      };
      const result = await callback(tx as unknown as Transaction);
      if ((queried && this.revision !== initialRevision) || [...reads].some(([path, data]) => this.documents.get(path) !== data)) continue;
      if (this.failNextCommit) {
        this.failNextCommit = false;
        throw new Error("commit failed");
      }
      if ([...pending.keys()].some((path) => this.documents.has(path))) throw new Error("既存文書の上書きは禁止です");
      for (const [path, data] of pending) this.documents.set(path, data);
      if (pending.size) this.revision++;
      return result;
    }
    throw new Error("Transaction exhausted");
  }
}
