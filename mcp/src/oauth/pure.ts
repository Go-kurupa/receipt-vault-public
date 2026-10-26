import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { McpScope } from '../scopes';

// アプリのドメインに窓口と認可の入口をまとめる（Hosting rewrite。2026-10-13 スパイク①で確認済み）。
export const ISSUER = 'https://your-firebase-project-id.web.app';
export const RESOURCE = `${ISSUER}/mcp`;
export const PRM_URL = `${ISSUER}/.well-known/oauth-protected-resource/mcp`;
export const CONNECT_URL = `${ISSUER}/connect`;
export const OAUTH_SCOPES: readonly McpScope[] = ['receipts:read', 'receipts:organize'];
/** 戻り先として許すホスト（https のみ）。ChatGPT と Claude のコネクタだけ。 */
export const REDIRECT_HOSTS: readonly string[] = ['chatgpt.com', 'claude.ai', 'claude.com'];
export const REQUEST_TTL_MS = 10 * 60_000;
export const CODE_TTL_MS = 10 * 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
export const ACCEPT_WINDOW_MS = 10 * 60_000;
export const ACCESS_PREFIX = 'rca_';
export const REFRESH_PREFIX = 'rcr_';
export const CODE_PREFIX = 'rcc_';

export function authorizationServerMetadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...OAUTH_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResourceMetadata() {
  return {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: ['receipts:read'],
    bearer_methods_supported: ['header'],
    resource_name: '領収書保管庫 receipt-vault',
  };
}

export function wwwAuthenticate(): string {
  return `Bearer resource_metadata="${PRM_URL}", scope="receipts:read"`;
}

export function newSecret(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url');
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!PKCE.test(verifier) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return false;
  const actual = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const expected = Buffer.from(challenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 戻り先 URL は https・許可ホスト・既定ポート・認証情報なし・フラグメントなし。 */
export function isAllowedRedirect(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.port === '' && !u.username && !u.password && !u.hash &&
    REDIRECT_HOSTS.includes(u.hostname.toLowerCase());
}

/** CIMD の client_id は https で、パスを持つ URL。 */
export function isCimdClientId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length > 2048) return false;
  try {
    const u = new URL(id);
    return u.protocol === 'https:' && u.pathname.length > 1 && !u.hash && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function isDcrClientId(id: unknown): id is string {
  return typeof id === 'string' && /^dcr_[A-Za-z0-9_-]{22,64}$/.test(id);
}

/** 要求された範囲を許可済みの範囲に絞る。読み取りは必ず含める（窓口の入口条件）。 */
export function parseScope(raw: unknown): McpScope[] | null {
  if (raw === undefined || raw === null || raw === '') return ['receipts:read'];
  if (typeof raw !== 'string') return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  const out = new Set<McpScope>(['receipts:read']);
  for (const p of parts) {
    if (p === 'offline_access') continue;
    const known = OAUTH_SCOPES.find((s) => s === p);
    if (!known) return null;
    out.add(known);
  }
  return OAUTH_SCOPES.filter((s) => out.has(s));
}

/** RFC 8707: resource は正規の窓口 URL と一致すること（大文字のスキーム・ホスト、末尾スラッシュは許容）。 */
export function resourceMatches(raw: unknown): boolean {
  if (raw === undefined) return true; // 古いクライアント向け。発行するトークンは常に RESOURCE 宛て。
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, '');
    return u.protocol === 'https:' && u.host.toLowerCase() === new URL(ISSUER).host && path === '/mcp' && !u.search && !u.hash;
  } catch {
    return false;
  }
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scopes: McpScope[];
}

/**
 * 戻り先の検証より前の失敗は、戻り先へ転送してはいけない（open redirect 防止）。
 * redirectable: false のエラーは画面に表示するだけにする。
 */
export function parseAuthorizeQuery(q: Record<string, unknown>):
  | { ok: true; value: AuthorizeParams }
  | { ok: false; error: string; description: string; redirectable: boolean } {
  const one = (v: unknown) => (Array.isArray(v) ? undefined : v);
  const clientId = one(q.client_id);
  const redirectUri = one(q.redirect_uri);
  if (!isCimdClientId(clientId) && !isDcrClientId(clientId))
    return { ok: false, error: 'invalid_client', description: 'client_id が不正です', redirectable: false };
  if (!isAllowedRedirect(redirectUri))
    return { ok: false, error: 'invalid_request', description: '戻り先が許可されていません', redirectable: false };
  const state = one(q.state);
  if (state !== undefined && (typeof state !== 'string' || state.length > 1024))
    return { ok: false, error: 'invalid_request', description: 'state が不正です', redirectable: false };
  if (one(q.response_type) !== 'code')
    return { ok: false, error: 'unsupported_response_type', description: 'response_type は code のみです', redirectable: true };
  const challenge = one(q.code_challenge);
  if (one(q.code_challenge_method) !== 'S256' || typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
    return { ok: false, error: 'invalid_request', description: 'PKCE (S256) が必要です', redirectable: true };
  if (!resourceMatches(one(q.resource)))
    return { ok: false, error: 'invalid_target', description: 'resource が不正です', redirectable: true };
  const scopes = parseScope(one(q.scope));
  if (!scopes) return { ok: false, error: 'invalid_scope', description: 'scope が不正です', redirectable: true };
  return { ok: true, value: { clientId, redirectUri, state: typeof state === 'string' ? state : null, codeChallenge: challenge, scopes } };
}

export function redirectWith(redirectUri: string, params: Record<string, string | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  u.searchParams.set('iss', ISSUER);
  return u.toString();
}

/** CIMD 文書の検証。client_id 完全一致・名前・redirect_uris に要求の戻り先が完全一致で含まれる。 */
export function validateCimdDocument(doc: unknown, clientId: string, redirectUri: string): { ok: true; clientName: string } | { ok: false; reason: string } {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'not_object' };
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) return { ok: false, reason: 'client_id_mismatch' };
  if (!Array.isArray(d.redirect_uris) || !d.redirect_uris.every((u) => typeof u === 'string')) return { ok: false, reason: 'no_redirect_uris' };
  if (!d.redirect_uris.includes(redirectUri)) return { ok: false, reason: 'redirect_not_listed' };
  // こちらは公開クライアント（none）として扱う。ChatGPT は private_key_jwt を既定にしつつ none にも対応と宣言している。
  const supported = d.token_endpoint_auth_methods_supported;
  const supportsNone = Array.isArray(supported)
    ? supported.includes('none')
    : d.token_endpoint_auth_method === undefined || d.token_endpoint_auth_method === 'none';
  if (!supportsNone) return { ok: false, reason: 'auth_method' };
  return { ok: true, clientName: displayName(d.client_name, clientId) };
}

export function displayName(name: unknown, clientId: string): string {
  const clean = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '';
  if (clean) return clean;
  try {
    return new URL(clientId).hostname;
  } catch {
    return '不明なアプリ';
  }
}

/** 画面に出す要求元。名前は自己申告なので、戻り先ホストで判定した名前も並べて出す。 */
export function vendorOf(redirectUri: string): string {
  const host = new URL(redirectUri).hostname.toLowerCase();
  if (host === 'chatgpt.com') return 'ChatGPT';
  if (host === 'claude.ai' || host === 'claude.com') return 'Claude';
  return host;
}
