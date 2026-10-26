import { randomUUID } from 'node:crypto';
import { FieldValue, type DocumentData, type Firestore } from 'firebase-admin/firestore';
import { OWNER_EMAIL } from '../auth';
import { ACCEPT_WINDOW_MS, CODE_PREFIX, CODE_TTL_MS, hashSecret, newSecret, redirectWith } from '../oauth/pure';
import { ManageError } from './errors';

export const ACCEPT_DOC = 'mcp_settings/oauth_accept';

export interface GrantSummary {
  grantId: string;
  clientName: string;
  vendor: string;
  scopes: string[];
  createdAt: string | null;
  revoked: boolean;
}

function iso(value: unknown): string | null {
  const v = value as { toDate?: () => Date } | null | undefined;
  try {
    const d = v?.toDate?.();
    return d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : null;
  } catch {
    return null;
  }
}

export async function listGrants(db: Firestore): Promise<{ grants: GrantSummary[]; acceptUntil: number }> {
  const [snap, accept] = await Promise.all([
    db.collection('mcp_oauth_grants').where('ownerEmail', '==', OWNER_EMAIL).get(),
    db.doc(ACCEPT_DOC).get(),
  ]);
  const grants = snap.docs.map((doc) => {
    const d = doc.data();
    return {
      grantId: doc.id,
      clientName: typeof d.clientName === 'string' ? d.clientName : '不明なアプリ',
      vendor: typeof d.vendor === 'string' ? d.vendor : '不明',
      scopes: Array.isArray(d.scopes) ? d.scopes.filter((s: unknown): s is string => typeof s === 'string') : [],
      createdAt: iso(d.createdAt),
      revoked: d.revokedAt != null,
    };
  });
  grants.sort((a, b) => Number(a.revoked) - Number(b.revoked) || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const until = accept.data()?.until;
  return { grants, acceptUntil: typeof until === 'number' ? until : 0 };
}

/** 「新しい接続を受け付ける」: ここから 10 分間だけ、許可を 1 回受け付ける。 */
export async function openAcceptWindow(db: Firestore, now: number): Promise<{ acceptUntil: number }> {
  const until = now + ACCEPT_WINDOW_MS;
  await db.doc(ACCEPT_DOC).set({ until, updatedAt: FieldValue.serverTimestamp() });
  return { acceptUntil: until };
}

export async function closeAcceptWindow(db: Firestore): Promise<{ acceptUntil: number }> {
  await db.doc(ACCEPT_DOC).set({ until: 0, updatedAt: FieldValue.serverTimestamp() });
  return { acceptUntil: 0 };
}

function usable(data: DocumentData | undefined, now: number) {
  if (!data) throw new ManageError('not_found', '接続の要求が見つかりません。AI 側で接続をやり直してください');
  if (data.usedAt != null) throw new ManageError('revoked', 'この接続の要求はすでに処理されています');
  if (now > data.expiresAt) throw new ManageError('revoked', '接続の要求の期限が切れました。AI 側で接続をやり直してください');
  return data;
}

export async function getOauthRequest(db: Firestore, requestId: string, now: number) {
  const [snap, accept] = await Promise.all([db.doc(`mcp_oauth_requests/${requestId}`).get(), db.doc(ACCEPT_DOC).get()]);
  const data = usable(snap.data(), now);
  const until = accept.data()?.until;
  return {
    clientName: String(data.clientName),
    vendor: String(data.vendor),
    redirectHost: new URL(String(data.redirectUri)).hostname,
    requestedScopes: Array.isArray(data.scopes) ? data.scopes : ['receipts:read'],
    expiresAt: Number(data.expiresAt),
    acceptOpen: typeof until === 'number' && until > now,
  };
}

/**
 * 許可／拒否を確定し、AI の戻り先 URL を返す。許可は受付窓が開いているときだけ・1 回で窓を閉じる。
 * 認可コードの値は戻り先 URL にだけ載せ、保存は指紋のみ。
 */
export async function decideOauthRequest(
  db: Firestore,
  args: { requestId: string; approve: boolean; organize: boolean; now: number; owner: { uid: string } }
): Promise<{ redirectUrl: string }> {
  return db.runTransaction(async (tx) => {
    const reqRef = db.doc(`mcp_oauth_requests/${args.requestId}`);
    const [snap, accept] = await Promise.all([tx.get(reqRef), tx.get(db.doc(ACCEPT_DOC))]);
    const data = usable(snap.data(), args.now);
    const redirectUri = String(data.redirectUri);
    const state = typeof data.state === 'string' ? data.state : null;
    if (!args.approve) {
      tx.update(reqRef, { usedAt: args.now, decision: 'denied' });
      return { redirectUrl: redirectWith(redirectUri, { error: 'access_denied', error_description: '利用者が拒否しました', state }) };
    }
    const until = accept.data()?.until;
    if (!(typeof until === 'number' && until > args.now)) {
      throw new ManageError('revoked', '新しい接続の受付が閉じています。「AI 接続」タブで「新しい接続を受け付ける」を押してから、もう一度許可してください');
    }
    const scopes = args.organize ? ['receipts:read', 'receipts:organize'] : ['receipts:read'];
    const grantId = randomUUID();
    const code = newSecret(CODE_PREFIX);
    tx.create(db.doc(`mcp_oauth_grants/${grantId}`), {
      clientId: data.clientId, clientName: data.clientName, vendor: data.vendor, scopes,
      ownerUid: args.owner.uid, ownerEmail: OWNER_EMAIL, createdAt: FieldValue.serverTimestamp(), revokedAt: null,
    });
    tx.create(db.doc(`mcp_oauth_codes/${hashSecret(code)}`), {
      grantId, clientId: data.clientId, redirectUri, codeChallenge: data.codeChallenge, expiresAt: args.now + CODE_TTL_MS, usedAt: null,
    });
    tx.update(reqRef, { usedAt: args.now, decision: 'approved', grantId });
    tx.set(db.doc(ACCEPT_DOC), { until: 0, updatedAt: FieldValue.serverTimestamp() });
    return { redirectUrl: redirectWith(redirectUri, { code, state }) };
  });
}

export async function revokeGrant(db: Firestore, grantId: string): Promise<{ grantId: string; already: boolean }> {
  const already = await db.runTransaction(async (tx) => {
    const ref = db.doc(`mcp_oauth_grants/${grantId}`);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.ownerEmail !== OWNER_EMAIL) throw new ManageError('not_found', '接続が見つかりません');
    if (snap.data()?.revokedAt != null) return true;
    tx.update(ref, { revokedAt: FieldValue.serverTimestamp(), revokedReason: 'owner' });
    return false;
  });
  return { grantId, already };
}
