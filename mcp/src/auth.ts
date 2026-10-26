import { adminAuth, db } from './admin';
import { hashMcpKey, parseBearer } from './keys-pure';
import type { McpRequestContext } from './server';
import { parseKeyScopes, type McpScope } from './scopes';
import { RESOURCE } from './oauth/pure';
export const ALLOWED_EMAILS = ['owner@example.com'] as const;
export const OWNER_EMAIL = ALLOWED_EMAILS[0];
export class McpAuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
    readonly reason: string
  ) {
    super(message);
  }
}
/** 接続キー: 最上位 mcp_keys（receipts の下にサブコレクションを作らない）。 */
async function keyRecord(keyId: string): Promise<Record<string, unknown>> {
  const snap = await db.doc(`mcp_keys/${keyId}`).get();
  if (!snap.exists) throw new McpAuthError(401, '接続キーが無効です', 'unknown_key');
  const data = snap.data()!;
  if (data.revokedAt != null) throw new McpAuthError(401, '接続キーが無効です', 'revoked');
  return data;
}

/** ログイン連携のアクセストークン: 期限・許可の取り消し・宛先（resource）を毎回確認する。 */
async function oauthTokenRecord(keyId: string): Promise<Record<string, unknown>> {
  const snap = await db.doc(`mcp_oauth_tokens/${keyId}`).get();
  const data = snap.data();
  if (!snap.exists || !data) throw new McpAuthError(401, '接続が無効です', 'unknown_token');
  if (typeof data.expiresAt !== 'number' || Date.now() > data.expiresAt) throw new McpAuthError(401, '接続の期限が切れました', 'expired');
  if (data.resource !== RESOURCE) throw new McpAuthError(401, '接続が無効です', 'audience');
  const grant = await db.doc(`mcp_oauth_grants/${String(data.grantId)}`).get();
  if (!grant.exists || grant.data()?.revokedAt != null) throw new McpAuthError(401, '接続が取り消されています', 'grant_revoked');
  // 接続の識別子はトークン更新で変わらない grant 単位にする（下書きの所有確認・回数制限が続けて効くように）。
  return { ...data, label: `oauth:${String(grant.data()?.clientName ?? 'unknown')}`, connectionId: hashMcpKey(`grant:${String(data.grantId)}`) };
}

export async function authenticateMcpRequest(
  authorization: string | undefined,
  requiredScope: McpScope
): Promise<McpRequestContext> {
  const key = parseBearer(authorization);
  if (!key) throw new McpAuthError(401, '接続キーがありません', 'no_key');
  const keyId = hashMcpKey(key);
  const data = key.startsWith('rca_') ? await oauthTokenRecord(keyId) : await keyRecord(keyId);
  const uid: unknown = data?.ownerUid;
  if (typeof uid !== 'string' || !uid)
    throw new McpAuthError(403, '発行者のアカウントが無効です', 'disabled');
  const user = await adminAuth.getUser(uid).catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'auth/user-not-found'
    )
      return null;
    throw error;
  });
  if (!user || user.disabled)
    throw new McpAuthError(403, '発行者のアカウントが無効です', 'disabled');
  const email = user.email?.toLowerCase();
  if (
    !email ||
    !ALLOWED_EMAILS.some((allowed) => allowed === email) ||
    email !== data?.ownerEmail
  ) {
    throw new McpAuthError(403, 'このアカウントは利用できません', 'not_allowed');
  }
  const scopes = parseKeyScopes(data?.scopes);
  if (!scopes || !scopes.includes(requiredScope))
    throw new McpAuthError(403, 'この接続キーはこの窓口では使えません', 'scope');
  const connectionId = typeof data.connectionId === 'string' ? data.connectionId : keyId;
  return { uid, email, keyId: connectionId, keyLabel: typeof data?.label === 'string' ? data.label : 'unknown', scopes };
}
