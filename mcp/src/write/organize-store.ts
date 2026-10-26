import { createHash, randomUUID } from 'node:crypto';
import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { SERVER_TIMESTAMP, type ReceiptDoc } from '../../../functions/src/versioning';
import { OWNER_EMAIL } from '../auth';
import { buildOrganizeVersion, diffPatch, parseOrganizePatch, type OrganizePatch } from './organize-pure';
export const DRAFT_TTL_MS = 10 * 60 * 1000;
export interface Draft { keyId: string; chainId: string; baseDocId: string; baseVersion: number; patch: OrganizePatch; createdAt: number; expiresAt: number }
export class OrganizeError extends Error {
  constructor(readonly code: 'not_found' | 'deleted' | 'broken' | 'no_change' | 'draft_missing' | 'draft_expired' | 'draft_other_key' | 'conflict' | 'disabled', message: string) { super(message); }
}
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const timestamp = z.custom<unknown>(value => {
  try {
    if (!value || typeof value !== 'object' || !('toDate' in value) || typeof value.toDate !== 'function') return false;
    const date = value.toDate();
    return date instanceof Date && Number.isFinite(date.getTime());
  } catch { return false; }
});
const receiptSchema = z.object({
  kind: z.enum(['paper', 'digital']), receiptDate: z.string().min(1), amount: z.number().finite().positive(), vendor: z.string(),
  category: z.string().nullable(), businessRatio: z.number().finite().min(0).max(100), project: z.string().nullable(), memo: z.string().nullable(),
  receivedDate: z.string().min(1), registeredAt: timestamp, storagePath: z.string(), sha256: z.string(), mimeType: z.string(), resolutionOk: z.boolean(),
  chainId: id, version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1), prevVersionId: id.nullable(), deleted: z.boolean(), deletedAt: timestamp.nullable(),
  journalNo: z.string().nullable(), status: z.enum(['未記帳', '記帳済', '要確認']), source: z.string(), ocrText: z.string().nullable(),
}).passthrough();
const draftSchema = z.object({ keyId: z.string().min(1), chainId: id, baseDocId: id, baseVersion: z.number().int().positive(), patch: z.unknown(), createdAt: z.number().finite(), expiresAt: z.number().finite() });
const fieldsSchema = z.array(z.enum(['category', 'memo', 'project', 'businessRatio', 'status', 'journalNo']));
const resultSchema = z.object({ ok: z.literal(true), chainId: id, docId: id, version: z.number().int().positive() });
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
const hashDraft = (draft: Draft) => createHash('sha256').update(canonicalJson(draft)).digest('hex');
async function latestVersion(db: Firestore, tx: Transaction, chainId: string): Promise<ReceiptDoc & { docId: string }> {
  if (!id.safeParse(chainId).success) throw new OrganizeError('not_found', '領収書が見つかりません');
  const snap = await tx.get(db.collection('receipts').where('chainId', '==', chainId).orderBy('version', 'desc').limit(1));
  if (snap.empty) throw new OrganizeError('not_found', '領収書が見つかりません');
  const doc = snap.docs[0]!;
  const parsed = receiptSchema.safeParse(doc.data());
  if (!parsed.success || parsed.data.chainId !== chainId) throw new OrganizeError('broken', '最新版のデータが壊れています。画面で確認してください');
  // Preserve every existing field rather than normalizing the stored receipt.
  return { ...doc.data(), docId: doc.id } as ReceiptDoc & { docId: string };
}
function assertActive(latest: ReceiptDoc): void {
  if (latest.deleted) throw new OrganizeError('deleted', '削除済みの領収書は変更できません');
}
function validPatch(raw: unknown): OrganizePatch {
  const parsed = parseOrganizePatch(raw);
  if (!parsed.ok) throw new OrganizeError('broken', '訂正内容が不正です');
  return parsed.patch;
}
export async function createDraft(db: Firestore, args: { keyId: string; chainId: string; patch: OrganizePatch; now: number }): Promise<{ draftId: string; latest: ReceiptDoc & { docId: string }; changes: ReturnType<typeof diffPatch> }> {
  const patch = validPatch(args.patch);
  const draftId = randomUUID();
  return db.runTransaction(async tx => {
    const latest = await latestVersion(db, tx, args.chainId);
    assertActive(latest);
    const changes = diffPatch(latest, patch);
    if (!changes.length) throw new OrganizeError('no_change', '現在の値と同じです。変更はありません');
    const draft: Draft = { keyId: args.keyId, chainId: args.chainId, baseDocId: latest.docId, baseVersion: latest.version, patch, createdAt: args.now, expiresAt: args.now + DRAFT_TTL_MS };
    tx.create(db.doc(`mcp_drafts/${draftId}`), draft);
    return { draftId, latest, changes };
  });
}
export async function applyDraft(db: Firestore, args: { keyId: string; keyLabel: string; draftId: string; now: number }, onApplied?: (fields: string[]) => void): Promise<{ chainId: string; docId: string; version: number; replayed: boolean }> {
  if (!id.safeParse(args.draftId).success) throw new OrganizeError('draft_missing', '下書きが見つかりません');
  const committed = await db.runTransaction(async tx => {
    const logRef = db.doc(`requestLog/${args.draftId}`);
    const log = await tx.get(logRef);
    if (log.exists && log.data()?.fn !== 'mcpOrganizeApply') throw new OrganizeError('conflict', 'この下書きIDは別の処理で使用済みです');
    // Retained draft verifies full key identity even on replay (log stores only a prefix).
    const snap = await tx.get(db.doc(`mcp_drafts/${args.draftId}`));
    if (!snap.exists) throw new OrganizeError('draft_missing', '下書きが見つかりません');
    const parsed = draftSchema.safeParse(snap.data());
    if (!parsed.success) throw new OrganizeError('broken', '下書きのデータが壊れています');
    const draft: Draft = { ...parsed.data, patch: validPatch(parsed.data.patch) };
    if (draft.keyId !== args.keyId) throw new OrganizeError('draft_other_key', '別の接続キーで作られた下書きです');
    const payloadHash = hashDraft(draft);
    if (log.exists) {
      const result = resultSchema.safeParse(log.data()?.result);
      const fields = fieldsSchema.safeParse(log.data()?.fields);
      if (!result.success || !fields.success || log.data()?.payloadHash !== payloadHash || result.data.chainId !== draft.chainId) throw new OrganizeError('conflict', '要求記録と下書きが一致しません');
      return { chainId: result.data.chainId, docId: result.data.docId, version: result.data.version, replayed: true, fields: fields.data };
    }
    // Re-check the kill switch inside the transaction so a switch turned off mid-request stops the write (fail closed).
    const writeSwitch = await tx.get(db.doc('mcp_settings/receipts_write'));
    if (!writeSwitch.exists || writeSwitch.data()?.enabled !== true) throw new OrganizeError('disabled', '書き込みは停止中です');
    if (args.now > draft.expiresAt) throw new OrganizeError('draft_expired', '下書きの有効期限が切れています。下書きを作り直してください');
    const latest = await latestVersion(db, tx, draft.chainId);
    if (latest.docId !== draft.baseDocId || latest.version !== draft.baseVersion) throw new OrganizeError('conflict', '確認の後に別の場所で変更されています。下書きを作り直してください');
    assertActive(latest);
    const changes = diffPatch(latest, draft.patch);
    if (!changes.length) throw new OrganizeError('no_change', '現在の値と同じです。変更はありません');
    const version = buildOrganizeVersion(latest, draft.patch);
    const data: Record<string, unknown> = { ...version };
    for (const field of ['registeredAt', 'deletedAt'] as const) if (data[field] === SERVER_TIMESTAMP) data[field] = FieldValue.serverTimestamp();
    const docId = randomUUID();
    const result = { ok: true, chainId: draft.chainId, docId, version: version.version };
    tx.create(db.doc(`receipts/${docId}`), data);
    tx.create(logRef, { fn: 'mcpOrganizeApply', payloadHash, ownerEmail: OWNER_EMAIL, result, via: 'mcp', keyId: args.keyId.slice(0, 8), keyLabel: args.keyLabel, fields: changes.map(c => c.field), createdAt: FieldValue.serverTimestamp() });
    return { chainId: result.chainId, docId, version: result.version, replayed: false, fields: changes.map(c => c.field) };
  });
  // Observe only committed metadata, never intermediate transaction retries or values.
  const { fields, ...result } = committed;
  onApplied?.(fields);
  return result;
}
