export const LATE_DAYS = 67; // CLI checkInputDeadline と同じ目安（約 2 か月＋7 営業日）

export interface ReceiptRecord {
  docId: string; chainId: string; version: number;
  kind: 'paper' | 'digital'; receiptDate: string; amount: number; vendor: string;
  category: string | null; businessRatio: number; project: string | null; memo: string | null;
  receivedDate: string | null; status: string; journalNo: string | null; deleted: boolean;
  source: string; mimeType: string | null; sha256: string | null;
  registeredAt: string | null; // ISO 8601
  ocrText: string | null;
}
export interface Chain { chainId: string; latest: ReceiptRecord; versions: ReceiptRecord[] }
export interface SearchCriteria {
  dateFrom?: string; dateTo?: string; amountMin?: number; amountMax?: number;
  vendor?: string; kind?: 'paper' | 'digital'; status?: string; category?: string;
  includeDeleted?: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const toIso = (v: unknown): string | null => {
  if (v && typeof v === 'object' && 'toDate' in v && typeof (v as { toDate: unknown }).toDate === 'function') {
    const d = (v as { toDate: () => Date }).toDate();
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
};

export function toRecord(docId: string, d: Record<string, unknown>): ReceiptRecord | null {
  const chainId = str(d.chainId);
  if (!chainId || typeof d.version !== 'number' || !Number.isInteger(d.version)) return null;
  if (typeof d.amount !== 'number' || !Number.isFinite(d.amount)) return null;
  const receiptDate = str(d.receiptDate);
  const vendor = str(d.vendor);
  if (!receiptDate || vendor === null) return null;
  const businessRatio = d.businessRatio === undefined ? 100 : d.businessRatio;
  if (typeof businessRatio !== 'number' || !Number.isFinite(businessRatio) || businessRatio < 0 || businessRatio > 100) return null;
  return {
    docId, chainId, version: d.version,
    kind: d.kind === 'digital' ? 'digital' : 'paper',
    receiptDate, amount: d.amount, vendor,
    category: str(d.category), project: str(d.project), memo: str(d.memo),
    businessRatio,
    receivedDate: str(d.receivedDate),
    status: str(d.status) ?? '未記帳',
    journalNo: str(d.journalNo),
    deleted: d.deleted === true,
    source: str(d.source) ?? '',
    mimeType: str(d.mimeType), sha256: str(d.sha256),
    registeredAt: toIso(d.registeredAt),
    ocrText: str(d.ocrText),
  };
}

export function groupChains(records: ReceiptRecord[]): Chain[] {
  const by: Record<string, ReceiptRecord[]> = Object.setPrototypeOf({}, null);
  for (const r of records) (by[r.chainId] ??= []).push(r);
  const chains: Chain[] = [];
  for (const [chainId, versions] of Object.entries(by)) {
    versions.sort((a, b) => b.version - a.version);
    chains.push({ chainId, latest: versions[0]!, versions });
  }
  return chains.sort((a, b) => (b.latest.registeredAt ?? '').localeCompare(a.latest.registeredAt ?? ''));
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase();

export function searchChains(chains: Chain[], c: SearchCriteria): Chain[] {
  const vendorQ = c.vendor?.trim() ? norm(c.vendor.trim()) : null;
  return chains.filter(({ latest: r }) => {
    if (!c.includeDeleted && r.deleted) return false;
    if (vendorQ && !norm(r.vendor).includes(vendorQ)) return false;
    if (c.dateFrom && r.receiptDate < c.dateFrom) return false;
    if (c.dateTo && r.receiptDate > c.dateTo) return false;
    if (c.amountMin !== undefined && r.amount < c.amountMin) return false;
    if (c.amountMax !== undefined && r.amount > c.amountMax) return false;
    if (c.kind && r.kind !== c.kind) return false;
    if (c.status && r.status !== c.status) return false;
    if (c.category && r.category !== c.category) return false;
    return true;
  });
}

export function summarize(chains: Chain[], by: 'month' | 'category' | 'project') {
  const map: Record<string, { key: string; total: number; businessTotal: number; count: number }> = Object.setPrototypeOf({}, null);
  for (const { latest: r } of chains) {
    if (r.deleted) continue;
    const key = by === 'month' ? r.receiptDate.slice(0, 7) : (by === 'category' ? r.category : r.project) || '（未設定）';
    const b = map[key] ?? { key, total: 0, businessTotal: 0, count: 0 };
    b.total += r.amount;
    b.businessTotal += Math.round((r.amount * r.businessRatio) / 100);
    b.count += 1;
    map[key] = b;
  }
  const buckets = Object.values(map);
  // 月別は新しい月が先（画面の monthlySummary と同じ）。科目・案件別は合計の大きい順。
  return by === 'month'
    ? buckets.sort((a, b) => b.key.localeCompare(a.key))
    : buckets.sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

// 訂正のたびに registeredAt は新しくなるため、登録の遅れは初版（最小 version）の登録日時で判定する。
export function isRegisteredLate({ latest, versions }: Chain): boolean {
  const first = versions[versions.length - 1]!;
  if (latest.kind !== 'paper' || !latest.receivedDate || !first.registeredAt) return false;
  const received = Date.parse(`${latest.receivedDate}T00:00:00+09:00`);
  const days = Math.floor((Date.parse(first.registeredAt) - received) / 86_400_000);
  return days > LATE_DAYS;
}
