import { createHash } from 'node:crypto';
import { beforeEach, expect, test, vi } from 'vitest';
import { fakeFirestore } from './fake-firestore';

const holder = vi.hoisted(() => ({ db: null as unknown, getUser: vi.fn() }));
vi.mock('../admin', () => ({ get db() { return holder.db; }, adminAuth: { getUser: holder.getUser } }));
vi.mock('firebase-functions', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { createOauthHandler } from './server';
import { decideOauthRequest, openAcceptWindow, revokeGrant } from '../admin-api/oauth-manage';
import { authenticateMcpRequest } from '../auth';
import { ISSUER, RESOURCE } from './pure';

const CLIENT = 'https://chatgpt.com/oauth/client.json';
const REDIRECT = 'https://chatgpt.com/connector/oauth/abc';
const verifier = 'x'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
let fs: ReturnType<typeof fakeFirestore>;
let now = 1_000_000;

function res() {
  const r: Record<string, unknown> & { statusCode?: number; body?: unknown; location?: string; headers: Record<string, string> } = { headers: {} };
  Object.assign(r, {
    headersSent: false,
    status: (c: number) => { r.statusCode = c; return r; },
    set: (k: string, v: string) => { r.headers[k] = v; return r; },
    json: (b: unknown) => { r.body = b; r.statusCode ??= 200; return r; },
    send: (b: unknown) => { r.body = b; return r; },
    redirect: (c: number, l: string) => { r.statusCode = c; r.location = l; return r; },
  });
  return r;
}
const handler = () => createOauthHandler({
  db: fs.db, now: () => now,
  fetchCimd: async () => ({ client_id: CLIENT, client_name: 'ChatGPT', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
});
let shared: ReturnType<typeof handler> | null = null;
const call = async (method: string, path: string, query: Record<string, unknown> = {}, body: Record<string, unknown> = {}, ip = '203.0.113.1') => {
  const r = res();
  const req = { method, path, query, body, headers: { 'x-forwarded-for': ip }, get: (h: string) => (h.toLowerCase() === 'x-forwarded-for' ? ip : undefined) };
  await (shared ??= handler())(req as never, r as never);
  return r;
};
const authorize = () => call('GET', '/oauth/authorize', {
  response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, state: 'st', code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE,
});
const requestIdFrom = (location: string) => new URL(location).searchParams.get('request')!;
const exchange = (code: string, v = verifier) => call('POST', '/oauth/token', {}, { grant_type: 'authorization_code', code, code_verifier: v, client_id: CLIENT, redirect_uri: REDIRECT, resource: RESOURCE });
const refresh = (token: string) => call('POST', '/oauth/token', {}, { grant_type: 'refresh_token', refresh_token: token, client_id: CLIENT, resource: RESOURCE });

beforeEach(() => {
  fs = fakeFirestore();
  holder.db = fs.db;
  holder.getUser.mockResolvedValue({ uid: 'u1', email: 'owner@example.com', disabled: false });
  now = 1_000_000;
  shared = null;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

async function approve(organize = false) {
  const r = await authorize();
  expect(r.statusCode).toBe(302);
  await openAcceptWindow(fs.db, now);
  const { redirectUrl } = await decideOauthRequest(fs.db, { requestId: requestIdFrom(r.location!), approve: true, organize, now, owner: { uid: 'u1' } });
  const u = new URL(redirectUrl);
  expect(u.origin + u.pathname).toBe(REDIRECT);
  expect(u.searchParams.get('state')).toBe('st');
  expect(u.searchParams.get('iss')).toBe(ISSUER);
  return u.searchParams.get('code')!;
}

test('full flow: authorize -> approve -> token -> MCP auth -> refresh rotation', async () => {
  const code = await approve(true);
  const t = await exchange(code);
  expect(t.statusCode).toBe(200);
  const tokens = t.body as { access_token: string; refresh_token: string; scope: string };
  expect(tokens.scope).toBe('receipts:read receipts:organize');
  expect(JSON.stringify([...fs.rows.values()])).not.toContain(tokens.access_token);
  const ctx = await authenticateMcpRequest(`Bearer ${tokens.access_token}`, 'receipts:read');
  expect(ctx).toMatchObject({ uid: 'u1', scopes: ['receipts:read', 'receipts:organize'], keyLabel: 'oauth:ChatGPT' });
  const r2 = await refresh(tokens.refresh_token);
  expect(r2.statusCode).toBe(200);
  const next = r2.body as { access_token: string };
  await expect(authenticateMcpRequest(`Bearer ${next.access_token}`, 'receipts:read')).resolves.toMatchObject({ uid: 'u1' });
});

test('approval needs the acceptance window and closes it after one use', async () => {
  const r = await authorize();
  await expect(decideOauthRequest(fs.db, { requestId: requestIdFrom(r.location!), approve: true, organize: false, now, owner: { uid: 'u1' } }))
    .rejects.toMatchObject({ message: expect.stringContaining('受付が閉じています') });
  await approve();
  const again = await authorize();
  await expect(decideOauthRequest(fs.db, { requestId: requestIdFrom(again.location!), approve: true, organize: false, now, owner: { uid: 'u1' } }))
    .rejects.toMatchObject({ message: expect.stringContaining('受付が閉じています') });
});

test('deny redirects with access_denied and no code', async () => {
  const r = await authorize();
  const { redirectUrl } = await decideOauthRequest(fs.db, { requestId: requestIdFrom(r.location!), approve: false, organize: false, now, owner: { uid: 'u1' } });
  expect(new URL(redirectUrl).searchParams.get('error')).toBe('access_denied');
  expect(new URL(redirectUrl).searchParams.has('code')).toBe(false);
});

test('wrong PKCE verifier, expired code and code reuse are refused; reuse revokes the grant', async () => {
  const code = await approve();
  expect((await exchange(code, 'y'.repeat(64))).statusCode).toBe(400);
  const ok = await exchange(code);
  expect(ok.statusCode).toBe(200);
  const reuse = await exchange(code);
  expect(reuse.statusCode).toBe(400);
  await expect(authenticateMcpRequest(`Bearer ${(ok.body as { access_token: string }).access_token}`, 'receipts:read'))
    .rejects.toMatchObject({ reason: 'grant_revoked' });
  const late = await approve();
  now += 11 * 60_000;
  expect((await exchange(late)).statusCode).toBe(400);
});

test('refresh reuse revokes the grant; owner revocation stops tokens immediately', async () => {
  const tokens = (await exchange(await approve())).body as { access_token: string; refresh_token: string };
  expect((await refresh(tokens.refresh_token)).statusCode).toBe(200);
  expect((await refresh(tokens.refresh_token)).statusCode).toBe(400);
  const t2 = (await exchange(await approve())).body as { access_token: string };
  await expect(authenticateMcpRequest(`Bearer ${t2.access_token}`, 'receipts:read')).resolves.toBeTruthy();
  const grantId = [...fs.rows.entries()].filter(([p, d]) => p.startsWith('mcp_oauth_grants/') && d.revokedAt == null).map(([p]) => p.split('/')[1]!)[0]!;
  await revokeGrant(fs.db, grantId);
  await expect(authenticateMcpRequest(`Bearer ${t2.access_token}`, 'receipts:read')).rejects.toMatchObject({ status: 401 });
});

test('access tokens expire after an hour', async () => {
  const tokens = (await exchange(await approve())).body as { access_token: string };
  now += 61 * 60_000;
  await expect(authenticateMcpRequest(`Bearer ${tokens.access_token}`, 'receipts:read')).rejects.toMatchObject({ reason: 'expired' });
});

test('untrusted redirect is shown as a page, never redirected; metadata endpoints answer', async () => {
  const bad = await call('GET', '/oauth/authorize', { response_type: 'code', client_id: CLIENT, redirect_uri: 'https://evil.com/cb', code_challenge: challenge, code_challenge_method: 'S256' });
  expect(bad.statusCode).toBe(400);
  expect(bad.location).toBeUndefined();
  const mismatch = await call('GET', '/oauth/authorize', { response_type: 'code', client_id: CLIENT, redirect_uri: 'https://chatgpt.com/other', code_challenge: challenge, code_challenge_method: 'S256' });
  expect(mismatch.statusCode).toBe(400);
  expect(mismatch.location).toBeUndefined();
  expect((await call('GET', '/.well-known/oauth-authorization-server')).body).toMatchObject({ issuer: ISSUER });
  expect((await call('GET', '/.well-known/oauth-protected-resource/mcp')).body).toMatchObject({ resource: RESOURCE });
});

test('the connection id stays the same across refresh so drafts keep working (review M7)', async () => {
  const first = (await exchange(await approve(true))).body as { access_token: string; refresh_token: string };
  const a = await authenticateMcpRequest(`Bearer ${first.access_token}`, 'receipts:read');
  const second = (await refresh(first.refresh_token)).body as { access_token: string };
  const b = await authenticateMcpRequest(`Bearer ${second.access_token}`, 'receipts:read');
  expect(b.keyId).toBe(a.keyId);
});

test('one source cannot exhaust authorize for everyone; the exchange endpoint is limited and strict (review M4/M5)', async () => {
  const ask = (ip: string) => call('GET', '/oauth/authorize', {
    response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, state: 'st', code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE,
  }, {}, ip);
  for (let i = 0; i < 20; i++) await ask('198.51.100.9');
  expect((await ask('198.51.100.9')).statusCode).toBe(429);
  expect((await ask('203.0.113.50')).statusCode).toBe(302);
  const malformed = await call('POST', '/oauth/token', {}, { grant_type: 'refresh_token', refresh_token: 'rcr_short', client_id: CLIENT });
  expect(malformed.statusCode).toBe(400);
  let last = 0;
  for (let i = 0; i < 70; i++) {
    last = (await call('POST', '/oauth/token', {}, { grant_type: 'refresh_token', refresh_token: 'rcr_' + 'A'.repeat(43), client_id: CLIENT }, '192.0.2.77')).statusCode!;
  }
  expect(last).toBe(429);
});

test('DCR registers only allowlisted redirects', async () => {
  expect((await call('POST', '/oauth/register', {}, { redirect_uris: ['https://evil.com/cb'] })).statusCode).toBe(400);
  const ok = await call('POST', '/oauth/register', {}, { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' });
  expect(ok.statusCode).toBe(201);
  expect((ok.body as { client_id: string }).client_id).toMatch(/^dcr_/);
});
