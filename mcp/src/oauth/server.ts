import { randomBytes, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import {
  ACCESS_PREFIX, ACCESS_TTL_MS, CONNECT_URL, REFRESH_PREFIX, REFRESH_TTL_MS, REQUEST_TTL_MS, RESOURCE,
  authorizationServerMetadata, hashSecret, isAllowedRedirect, isCimdClientId, isDcrClientId, newSecret, parseAuthorizeQuery,
  protectedResourceMetadata, redirectWith, resourceMatches, validateCimdDocument, displayName, vendorOf, verifyPkce,
} from './pure';

export interface OauthDeps {
  db: Firestore;
  now: () => number;
  fetchCimd: (clientId: string) => Promise<unknown>;
}

/**
 * maxInstances: 1 のため関数内の回数制限で公開入口の乱用を抑える。
 * 送信元ごとの上限で 1 か所からの枯渇を防ぎ、全体上限で多数の送信元からの総量を抑える。
 * 送信元は X-Forwarded-For の先頭（偽装可能なので送信元ごとの制限は目安。全体上限が最後の歯止め）。
 */
export class SourceLimit {
  private bySource = new Map<string, number[]>();
  private all: number[] = [];
  constructor(private readonly perSource: number, private readonly total: number) {}
  allow(source: string, now: number): boolean {
    const fresh = (list: number[]) => list.filter((t) => now - t < 3_600_000);
    this.all = fresh(this.all);
    const mine = fresh(this.bySource.get(source) ?? []);
    if (mine.length >= this.perSource || this.all.length >= this.total) return false;
    mine.push(now);
    this.all.push(now);
    if (!this.bySource.has(source) && this.bySource.size >= 2_000) this.bySource.delete(this.bySource.keys().next().value!);
    this.bySource.set(source, mine);
    return true;
  }
}

function sourceOf(req: Request): string {
  const forwarded = (typeof req.get === 'function' ? req.get('x-forwarded-for') : undefined) ?? '';
  return forwarded.split(',')[0]?.trim() || req.ip || 'unknown';
}

const CODE_FORMAT = /^rcc_[A-Za-z0-9_-]{43}$/;
const REFRESH_FORMAT = /^rcr_[A-Za-z0-9_-]{43}$/;
const VERIFIER_FORMAT = /^[A-Za-z0-9._~-]{43,128}$/;
const MAX_BODY_BYTES = 16 * 1024;

function page(res: Response, status: number, message: string): void {
  // 戻り先を信用できない失敗は転送せず、ここで表示して終わる（open redirect 防止）。
  res.status(status).set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-store')
    .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>接続できません</title>` +
      `<p style="font-family:sans-serif;padding:1rem">接続を開始できませんでした: ${message.replace(/[<>&"]/g, '')}</p>`);
}

function tokenError(res: Response, error: string, description: string, status = 400): void {
  res.status(status).set('Cache-Control', 'no-store').json({ error, error_description: description });
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

async function issueTokens(tx: Transaction, db: Firestore, now: number, grant: { id: string; clientId: string; scopes: string[]; ownerUid: string; ownerEmail: string }) {
  const access = newSecret(ACCESS_PREFIX);
  const refresh = newSecret(REFRESH_PREFIX);
  tx.create(db.doc(`mcp_oauth_tokens/${hashSecret(access)}`), {
    grantId: grant.id, clientId: grant.clientId, scopes: grant.scopes, ownerUid: grant.ownerUid, ownerEmail: grant.ownerEmail,
    resource: RESOURCE, expiresAt: now + ACCESS_TTL_MS, createdAt: FieldValue.serverTimestamp(),
  });
  tx.create(db.doc(`mcp_oauth_refresh/${hashSecret(refresh)}`), {
    grantId: grant.id, clientId: grant.clientId, expiresAt: now + REFRESH_TTL_MS, usedAt: null, createdAt: FieldValue.serverTimestamp(),
  });
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: grant.scopes.join(' ') };
}

type GrantRow = { clientId: string; scopes: string[]; ownerUid: string; ownerEmail: string; revokedAt?: unknown };

export function createOauthHandler(deps: OauthDeps) {
  const registerLimit = new SourceLimit(5, 50);
  const authorizeLimit = new SourceLimit(20, 300);
  const exchangeLimit = new SourceLimit(60, 1_000);
  const { db } = deps;

  async function authorize(req: Request, res: Response) {
    const parsed = parseAuthorizeQuery(req.query as Record<string, unknown>);
    const clientId = str(req.query.client_id);
    const redirectUri = str(req.query.redirect_uri);
    if (!parsed.ok && !parsed.redirectable) return page(res, 400, parsed.description);
    if (!authorizeLimit.allow(sourceOf(req), deps.now())) return page(res, 429, '要求が多すぎます。しばらくしてからお試しください');
    // ここで client と戻り先の組を確かめてから、初めて戻り先へのエラー転送を許す。
    let clientName: string;
    if (isCimdClientId(clientId)) {
      let doc: unknown;
      try {
        doc = await deps.fetchCimd(clientId);
      } catch {
        logger.warn('oauth_authorize', { result: 'cimd_unavailable', clientHost: new URL(clientId).hostname });
        return page(res, 400, 'アプリの情報を取得できませんでした');
      }
      const checked = validateCimdDocument(doc, clientId, redirectUri!);
      if (!checked.ok) {
        logger.warn('oauth_authorize', { result: 'cimd_invalid', reason: checked.reason, clientHost: new URL(clientId).hostname });
        return page(res, 400, 'アプリの情報が要求と一致しません');
      }
      clientName = checked.clientName;
    } else if (isDcrClientId(clientId)) {
      const snap = await db.doc(`mcp_oauth_clients/${clientId}`).get();
      const uris = snap.data()?.redirectUris;
      if (!snap.exists || !Array.isArray(uris) || !uris.includes(redirectUri)) return page(res, 400, 'アプリの登録が要求と一致しません');
      clientName = displayName(snap.data()?.clientName, 'https://unknown/');
    } else {
      return page(res, 400, 'client_id が不正です');
    }
    if (!parsed.ok) return res.redirect(302, redirectWith(redirectUri!, { error: parsed.error, error_description: parsed.description, state: str(req.query.state) ?? null }));
    const now = deps.now();
    const id = randomUUID();
    await db.doc(`mcp_oauth_requests/${id}`).create({
      clientId: parsed.value.clientId, clientName, vendor: vendorOf(parsed.value.redirectUri), redirectUri: parsed.value.redirectUri,
      state: parsed.value.state, codeChallenge: parsed.value.codeChallenge, scopes: parsed.value.scopes,
      createdAt: now, expiresAt: now + REQUEST_TTL_MS, usedAt: null,
    });
    logger.info('oauth_authorize', { result: 'pending', vendor: vendorOf(parsed.value.redirectUri), clientHost: isCimdClientId(clientId) ? new URL(clientId).hostname : 'dcr' });
    res.redirect(302, `${CONNECT_URL}?request=${id}`);
  }

  async function token(req: Request, res: Response) {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const grantType = str(body.grant_type);
    const clientId = str(body.client_id);
    const now = deps.now();
    // データベースに触れる前に、大きさ・回数・形式で弾く。
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if ((rawBody?.length ?? 0) > MAX_BODY_BYTES) return tokenError(res, 'invalid_request', '要求が大きすぎます', 413);
    if (!exchangeLimit.allow(sourceOf(req), now)) return tokenError(res, 'temporarily_unavailable', '要求が多すぎます', 429);
    if (!clientId || clientId.length > 2048) return tokenError(res, 'invalid_client', 'client_id が必要です', 401);
    if (grantType === 'authorization_code') {
      const code = str(body.code);
      const verifier = str(body.code_verifier);
      const redirectUri = str(body.redirect_uri);
      if (!code || !CODE_FORMAT.test(code) || !verifier || !VERIFIER_FORMAT.test(verifier) || !resourceMatches(body.resource)) {
        return tokenError(res, 'invalid_grant', '認可コードが不正です');
      }
      const out = await db.runTransaction(async (tx) => {
        const codeRef = db.doc(`mcp_oauth_codes/${hashSecret(code!)}`);
        const c = await tx.get(codeRef);
        const data = c.data();
        if (!c.exists || !data) return { error: 'invalid_grant' as const, reason: 'unknown_code' };
        const grantRef = db.doc(`mcp_oauth_grants/${data.grantId}`);
        const g = await tx.get(grantRef);
        const grant = g.data() as GrantRow | undefined;
        if (data.usedAt != null) {
          // 同じコードの 2 回目は盗用の疑い。その許可ごと失効させる（コミットさせるため throw しない）。
          if (g.exists) tx.update(grantRef, { revokedAt: FieldValue.serverTimestamp(), revokedReason: 'code_reuse' });
          return { error: 'invalid_grant' as const, reason: 'code_reuse' };
        }
        if (now > data.expiresAt) return { error: 'invalid_grant' as const, reason: 'expired' };
        if (data.clientId !== clientId || (redirectUri !== undefined && data.redirectUri !== redirectUri)) return { error: 'invalid_grant' as const, reason: 'client_mismatch' };
        if (!verifyPkce(verifier, data.codeChallenge)) return { error: 'invalid_grant' as const, reason: 'pkce' };
        if (!g.exists || !grant || grant.revokedAt != null) return { error: 'invalid_grant' as const, reason: 'grant_revoked' };
        tx.update(codeRef, { usedAt: now });
        return { tokens: await issueTokens(tx, db, now, { id: grantRef.id, ...grant }) };
      });
      if ('error' in out) {
        logger.warn('oauth_token', { grantType, result: out.reason });
        return tokenError(res, 'invalid_grant', '認可コードが無効です');
      }
      logger.info('oauth_token', { grantType, result: 'ok' });
      return res.status(200).set('Cache-Control', 'no-store').json(out.tokens);
    }
    if (grantType === 'refresh_token') {
      const refresh = str(body.refresh_token);
      if (!refresh || !REFRESH_FORMAT.test(refresh) || !resourceMatches(body.resource)) return tokenError(res, 'invalid_grant', '更新トークンが不正です');
      const out = await db.runTransaction(async (tx) => {
        const ref = db.doc(`mcp_oauth_refresh/${hashSecret(refresh!)}`);
        const r = await tx.get(ref);
        const data = r.data();
        if (!r.exists || !data) return { error: 'invalid_grant' as const, reason: 'unknown_refresh' };
        const grantRef = db.doc(`mcp_oauth_grants/${data.grantId}`);
        const g = await tx.get(grantRef);
        const grant = g.data() as GrantRow | undefined;
        if (data.usedAt != null) {
          // 交換済みの更新トークンの再利用＝盗用の疑い。許可ごと失効。
          if (g.exists) tx.update(grantRef, { revokedAt: FieldValue.serverTimestamp(), revokedReason: 'refresh_reuse' });
          return { error: 'invalid_grant' as const, reason: 'refresh_reuse' };
        }
        if (now > data.expiresAt || data.clientId !== clientId) return { error: 'invalid_grant' as const, reason: 'expired_or_client' };
        if (!g.exists || !grant || grant.revokedAt != null) return { error: 'invalid_grant' as const, reason: 'grant_revoked' };
        tx.update(ref, { usedAt: now });
        return { tokens: await issueTokens(tx, db, now, { id: grantRef.id, ...grant }) };
      });
      if ('error' in out) {
        logger.warn('oauth_token', { grantType, result: out.reason });
        return tokenError(res, 'invalid_grant', '更新トークンが無効です');
      }
      logger.info('oauth_token', { grantType, result: 'ok' });
      return res.status(200).set('Cache-Control', 'no-store').json(out.tokens);
    }
    return tokenError(res, 'unsupported_grant_type', '対応していない grant_type です');
  }

  async function register(req: Request, res: Response) {
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every(isAllowedRedirect)) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: '戻り先が許可されていません' });
    }
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'token_endpoint_auth_method は none のみです' });
    }
    if (!registerLimit.allow(sourceOf(req), deps.now())) return res.status(429).json({ error: 'temporarily_unavailable', error_description: '登録が多すぎます' });
    const clientId = `dcr_${randomBytes(18).toString('base64url')}`;
    const clientName = displayName(body.client_name, 'https://unknown/');
    await db.doc(`mcp_oauth_clients/${clientId}`).create({ clientName, redirectUris: uris, createdAt: FieldValue.serverTimestamp() });
    logger.info('oauth_register', { result: 'ok', vendor: vendorOf(uris[0] as string) });
    res.status(201).json({
      client_id: clientId, client_id_issued_at: Math.floor(deps.now() / 1000), client_name: clientName, redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    });
    return undefined;
  }

  return async (req: Request, res: Response): Promise<void> => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST').set('Access-Control-Allow-Headers', 'Content-Type, Authorization').status(204).send('');
      return;
    }
    const path = req.path.replace(/\/+$/, '');
    try {
      if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
        res.json(authorizationServerMetadata());
      } else if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
        res.json(protectedResourceMetadata());
      } else if (req.method === 'GET' && path === '/oauth/authorize') {
        await authorize(req, res);
      } else if (req.method === 'POST' && path === '/oauth/token') {
        await token(req, res);
      } else if (req.method === 'POST' && path === '/oauth/register') {
        await register(req, res);
      } else {
        res.status(404).json({ error: 'not_found' });
      }
    } catch {
      logger.error('oauth: unexpected error', { path });
      if (!res.headersSent) res.status(500).json({ error: 'server_error', error_description: '処理に失敗しました' });
    }
  };
}
