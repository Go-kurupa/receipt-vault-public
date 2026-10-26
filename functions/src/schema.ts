// receipt-vault CLI (MiniPC /opt/claude-discord/receipt-vault/src/schema.ts) の移植版。
// ロジックの正本は CLI 側。Web からの digital 登録専用に受領日入力期限チェックのみ省略している
// (電子取引データの真実性確保は事務処理規程で担保するため、スキャナ入力期限の概念が適用されない)。
export type ReceiptKind = "paper" | "digital";

export interface ReceiptInputRaw {
  kind: string;
  receiptDate: string;
  amount: number;
  vendor: string;
  receivedDate: string;
  source: string;
  category?: string;
  businessRatio?: number;
  project?: string;
  memo?: string;
}

export interface ReceiptInput {
  kind: ReceiptKind;
  receiptDate: string;
  amount: number;
  vendor: string;
  receivedDate: string;
  source: string;
  category: string | null;
  businessRatio: number;
  project: string | null;
  memo: string | null;
}

export type ParseResult = { ok: true; value: ReceiptInput } | { ok: false; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseReceiptInput(raw: ReceiptInputRaw): ParseResult {
  if (raw.kind !== "paper" && raw.kind !== "digital") {
    return { ok: false, error: `kind は "paper" または "digital" である必要があります: ${raw.kind}` };
  }
  if (!isValidDate(raw.receiptDate)) {
    return { ok: false, error: `receiptDate は YYYY-MM-DD 形式である必要があります: ${raw.receiptDate}` };
  }
  if (!isValidDate(raw.receivedDate)) {
    return { ok: false, error: `receivedDate は YYYY-MM-DD 形式である必要があります: ${raw.receivedDate}` };
  }
  if (!Number.isFinite(raw.amount) || raw.amount <= 0) {
    return { ok: false, error: `amount は正の数である必要があります: ${raw.amount}` };
  }
  if (!raw.vendor || raw.vendor.trim().length === 0) {
    return { ok: false, error: "vendor は空にできません" };
  }
  if (!raw.source || raw.source.trim().length === 0) {
    return { ok: false, error: "source は空にできません" };
  }
  const businessRatio = raw.businessRatio ?? 100;
  if (!Number.isFinite(businessRatio) || businessRatio < 0 || businessRatio > 100) {
    return { ok: false, error: `businessRatio は 0〜100 である必要があります: ${businessRatio}` };
  }

  return {
    ok: true,
    value: {
      kind: raw.kind,
      receiptDate: raw.receiptDate,
      amount: raw.amount,
      vendor: raw.vendor,
      receivedDate: raw.receivedDate,
      source: raw.source,
      category: raw.category ?? null,
      businessRatio,
      project: raw.project ?? null,
      memo: raw.memo ?? null,
    },
  };
}
