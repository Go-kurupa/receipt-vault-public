import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { OWNER_EMAIL } from '../auth';
import type { McpScope } from '../scopes';
import { ManageError } from './errors';
import { closeAcceptWindow, decideOauthRequest, getOauthRequest, listGrants, openAcceptWindow, revokeGrant } from './oauth-manage';

export type ManageRequest =
  | { action: 'list' }
  | { action: 'issue'; label: string; organize: boolean }
  | { action: 'setOrganize'; keyId: string; organize: boolean }
  | { action: 'revoke'; keyId: string }
  | { action: 'setWrite'; enabled: boolean }
  | { action: 'openAccept' }
  | { action: 'closeAccept' }
  | { action: 'getOauthRequest'; requestId: string }
  | { action: 'decideOauth'; requestId: string; approve: boolean; organize: boolean }
  | { action: 'revokeGrant'; grantId: string };

export { ManageError } from './errors';

export interface ManageDeps {
  db: Firestore;
  generateKey: () => string;
  hashKey: (key: string) => string;
  now?: () => number;
}

export interface KeySummary {
  keyId: string;
  label: string;
  scopes: string[];
  createdAt: string | null;
  createdBy: string | null;
  revoked: boolean;
}

/** Same condition as functions/src/index.ts requireOwner. */
export function isOwner(auth: { token: { email?: string; email_verified?: boolean } } | undefined): boolean {
  return !!auth && auth.token.email_verified === true && auth.token.email === OWNER_EMAIL;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function parseManageRequest(raw: unknown): { ok: true; req: ManageRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '要求の形が不正です' };
  const r = raw as Record<string, unknown>;
  const bool = (v: unknown): v is boolean => typeof v === 'boolean';
  const keyId = (v: unknown): v is string => typeof v === 'string' && KEY_ID.test(v);
  switch (r.action) {
    case 'list':
      return { ok: true, req: { action: 'list' } };
    case 'issue': {
      const label = typeof r.label === 'string' ? r.label.trim() : '';
      if (!label || Array.from(label).length > 40 || CONTROL.test(label)) return { ok: false, error: '名前は 1〜40 文字で入力してください' };
      if (!bool(r.organize)) return { ok: false, error: '権限の指定が不正です' };
      return { ok: true, req: { action: 'issue', label, organize: r.organize } };
    }
    case 'setOrganize':
      if (!keyId(r.keyId) || !bool(r.organize)) return { ok: false, error: '要求の形が不正です' };
      return { ok: true, req: { action: 'setOrganize', keyId: r.keyId, organize: r.organize } };
    case 'revoke':
      if (!keyId(r.keyId)) return { ok: false, error: '要求の形が不正です' };
      return { ok: true, req: { action: 'revoke', keyId: r.keyId } };
    case 'setWrite':
      if (!bool(r.enabled)) return { ok: false, error: '要求の形が不正です' };
      return { ok: true, req: { action: 'setWrite', enabled: r.enabled } };
    case 'openAccept':
    case 'closeAccept':
      return { ok: true, req: { action: r.action } };
    case 'getOauthRequest':
      if (!keyId(r.requestId)) return { ok: false, error: '要求の形が不正です' };
      return { ok: true, req: { action: 'getOauthRequest', requestId: r.requestId } };
    case 'decideOauth':
      if (!keyId(r.requestId) || !bool(r.approve) || !bool(r.organize)) return { ok: false, error: '要求の形が不正です' };
      return { ok: true, req: { action: 'decideOauth', requestId: r.requestId, approve: r.approve, organize: r.organize } };
    case 'revokeGrant':
      if (!keyId(r.grantId)) return { ok: false, error: '要求の形が不正です' };
      return { ok: true, req: { action: 'revokeGrant', grantId: r.grantId } };
    default:
      return { ok: false, error: '不明な操作です' };
  }
}

const scopesFor = (organize: boolean): McpScope[] => (organize ? ['receipts:read', 'receipts:organize'] : ['receipts:read']);

function iso(value: unknown): string | null {
  const v = value as { toDate?: () => Date } | null | undefined;
  try {
    const d = v?.toDate?.();
    return d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : null;
  } catch {
    return null;
  }
}

/** Reads a key owned by the signed-in owner; another owner's key is reported as not found. */
async function ownedKey(tx: Transaction, db: Firestore, keyId: string) {
  const ref = db.collection('mcp_keys').doc(keyId);
  const snap = await tx.get(ref);
  const data = snap.data();
  if (!snap.exists || data?.ownerEmail !== OWNER_EMAIL) throw new ManageError('not_found', '接続が見つかりません');
  return { ref, data: data! };
}

export async function runManage(deps: ManageDeps, req: ManageRequest, owner: { uid: string; email: string }) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  switch (req.action) {
    case 'list': {
      const [keys, writeSwitch] = await Promise.all([
        db.collection('mcp_keys').where('ownerEmail', '==', OWNER_EMAIL).get(),
        db.doc('mcp_settings/receipts_write').get(),
      ]);
      const summaries: KeySummary[] = keys.docs.map((doc) => {
        const d = doc.data();
        return {
          keyId: doc.id,
          label: typeof d.label === 'string' ? d.label : '(名前なし)',
          scopes: Array.isArray(d.scopes) ? d.scopes.filter((s: unknown): s is string => typeof s === 'string') : [],
          createdAt: iso(d.createdAt),
          createdBy: typeof d.createdBy === 'string' ? d.createdBy : null,
          revoked: d.revokedAt != null,
        };
      });
      summaries.sort((a, b) => Number(a.revoked) - Number(b.revoked) || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
      const { grants, acceptUntil } = await listGrants(db);
      return { writeEnabled: writeSwitch.exists && writeSwitch.data()?.enabled === true, keys: summaries, grants, acceptUntil };
    }
    case 'issue': {
      const key = deps.generateKey();
      const keyId = deps.hashKey(key);
      const scopes = scopesFor(req.organize);
      await db.runTransaction(async (tx) => {
        const same = await tx.get(db.collection('mcp_keys').where('ownerEmail', '==', OWNER_EMAIL).where('label', '==', req.label));
        // Labels identify keys for scripts/set-key-scopes.mts, so keep active labels unique.
        if (same.docs.some((doc) => doc.data()?.revokedAt == null)) throw new ManageError('duplicate_label', '同じ名前の接続がすでにあります');
        tx.create(db.collection('mcp_keys').doc(keyId), {
          ownerUid: owner.uid, ownerEmail: OWNER_EMAIL, label: req.label, scopes, createdAt: FieldValue.serverTimestamp(), createdBy: 'web',
        });
      });
      return { key, keyIdPrefix: keyId.slice(0, 8), label: req.label, scopes };
    }
    case 'setOrganize': {
      const scopes = scopesFor(req.organize);
      await db.runTransaction(async (tx) => {
        const { ref, data } = await ownedKey(tx, db, req.keyId);
        if (data.revokedAt != null) throw new ManageError('revoked', '取り消し済みの接続は変更できません');
        tx.update(ref, { scopes, scopesUpdatedAt: FieldValue.serverTimestamp() });
      });
      return { keyId: req.keyId, scopes };
    }
    case 'revoke': {
      const already = await db.runTransaction(async (tx) => {
        const { ref, data } = await ownedKey(tx, db, req.keyId);
        if (data.revokedAt != null) return true;
        tx.update(ref, { revokedAt: FieldValue.serverTimestamp() });
        return false;
      });
      return { keyId: req.keyId, revoked: true, already };
    }
    case 'setWrite':
      await db.doc('mcp_settings/receipts_write').set({ enabled: req.enabled, updatedAt: FieldValue.serverTimestamp() });
      return { writeEnabled: req.enabled };
    case 'openAccept':
      return openAcceptWindow(db, now());
    case 'closeAccept':
      return closeAcceptWindow(db);
    case 'getOauthRequest':
      return getOauthRequest(db, req.requestId, now());
    case 'decideOauth':
      return decideOauthRequest(db, { requestId: req.requestId, approve: req.approve, organize: req.organize, now: now(), owner });
    case 'revokeGrant':
      return revokeGrant(db, req.grantId);
  }
}
