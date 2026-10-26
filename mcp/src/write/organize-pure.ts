import { buildCorrectionDoc, type ReceiptDoc, type ReceiptStatus } from '../../../functions/src/versioning';
export type OrganizePatch = Partial<{ category: string | null; memo: string | null; project: string | null; businessRatio: number; status: ReceiptStatus; journalNo: string | null }>;
const fields = ['category', 'memo', 'project', 'businessRatio', 'status', 'journalNo'] as const;
export function parseOrganizePatch(raw: unknown): { ok: true; patch: OrganizePatch } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'patch はオブジェクトで指定してください' };
  const entries = Object.entries(raw);
  if (!entries.length) return { ok: false, error: '訂正する項目を指定してください' };
  const patch: OrganizePatch = {};
  for (const [name, value] of entries) {
    if (!fields.some(field => field === name)) return { ok: false, error: `${name} は訂正対象外です` };
    const field = name as keyof OrganizePatch;
    if (field === 'businessRatio') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return { ok: false, error: 'businessRatio は0〜100の数値で指定してください' };
      patch.businessRatio = value;
    } else if (field === 'status') {
      if (value !== '未記帳' && value !== '記帳済' && value !== '要確認') return { ok: false, error: 'status が不正です' };
      patch.status = value;
    } else {
      if (value === null) { patch[field] = null; continue; }
      const max = field === 'memo' ? 500 : field === 'journalNo' ? 50 : 40;
      if (typeof value !== 'string' || value.trim().length > max || (field !== 'memo' && !value.trim()) || (field === 'journalNo' && /[\u0000-\u001f\u007f-\u009f]/.test(value))) return { ok: false, error: `${field} の文字数または形式が不正です` };
      patch[field] = value.trim();
    }
  }
  return { ok: true, patch };
}
export function diffPatch(latest: ReceiptDoc, patch: OrganizePatch): { field: keyof OrganizePatch; before: unknown; after: unknown }[] {
  return (Object.keys(patch) as (keyof OrganizePatch)[]).filter(field => latest[field] !== patch[field]).map(field => ({ field, before: latest[field], after: patch[field] }));
}
export function buildOrganizeVersion(latest: ReceiptDoc & { docId: string }, patch: OrganizePatch): ReceiptDoc {
  return buildCorrectionDoc(latest, patch);
}
