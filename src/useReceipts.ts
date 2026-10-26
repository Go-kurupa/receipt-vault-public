import { useEffect, useState } from "react";
import { collection, getDocs, query } from "firebase/firestore";
import { db } from "./firebase";
import type { ReceiptDoc, ReceiptWithId } from "./types";

export interface ReceiptsState {
  chains: ReceiptChain[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

// 1 つの領収書 (chainId) の全版。latest は最新版 (訂正・削除を反映)。
export interface ReceiptChain {
  chainId: string;
  latest: ReceiptWithId;
  versions: ReceiptWithId[]; // version 降順
}

export function useReceipts(userId: string | null): ReceiptsState {
  const [chains, setChains] = useState<ReceiptChain[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setChains([]);
    setLoadedFor(null);
    setError(null);
    setLoading(false);
    if (!userId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const snap = await getDocs(query(collection(db, "receipts")));
        const byChain = new Map<string, ReceiptWithId[]>();
        for (const d of snap.docs) {
          const doc = { ...(d.data() as ReceiptDoc), docId: d.id };
          const list = byChain.get(doc.chainId) ?? [];
          list.push(doc);
          byChain.set(doc.chainId, list);
        }

        const result: ReceiptChain[] = [];
        for (const [chainId, versions] of byChain) {
          versions.sort((a, b) => b.version - a.version);
          result.push({ chainId, latest: versions[0], versions });
        }
        // 登録日時の新しい順 (最新版の registeredAt)
        result.sort((a, b) => {
          const ta = a.latest.registeredAt?.toMillis() ?? 0;
          const tb = b.latest.registeredAt?.toMillis() ?? 0;
          return tb - ta;
        });

        if (!cancelled) {
          setChains(result);
          setLoadedFor(userId);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, tick]);

  return { chains: loadedFor === userId ? chains : [], loading, error, reload: () => setTick((t) => t + 1) };
}
