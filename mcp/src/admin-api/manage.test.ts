import { expect, test } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { isOwner, parseManageRequest, runManage, ManageError, type KeySummary } from './manage';

type Row = Record<string, unknown>;
// Minimal Firestore stand-in: docs by path, equality queries, transactions that stage writes.
function fakeDb(seed: Record<string, Row> = {}) {
  const rows = new Map<string, Row>(Object.entries(seed));
  const ref = (path: string) => ({ path, id: path.split('/').pop()! });
  const snap = (path: string) => ({ id: path.split('/').pop()!, ref: ref(path), exists: rows.has(path), data: () => rows.get(path) });
  const query = (name: string, filters: [string, unknown][] = []) => ({
    where: (field: string, _op: string, value: unknown) => query(name, [...filters, [field, value]]),
    get: async () => ({ docs: [...rows.keys()].filter((p) => p.startsWith(name + '/') && filters.every(([f, v]) => rows.get(p)?.[f] === v)).map(snap) }),
    _q: { name, filters },
  });
  const db = {
    collection: (name: string) => ({ ...query(name), doc: (id: string) => ref(`${name}/${id}`) }),
    doc: (path: string) => ({ ...ref(path), get: async () => snap(path), set: async (data: Row) => { rows.set(path, data); } }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      const staged: [string, Row, 'create' | 'update'][] = [];
      const result = await fn({
        get: async (target: { path?: string; get?: () => Promise<unknown> }) => (target.path ? snap(target.path) : target.get!()),
        create: (r: { path: string }, data: Row) => staged.push([r.path, data, 'create']),
        update: (r: { path: string }, data: Row) => staged.push([r.path, data, 'update']),
      });
      for (const [path, data, kind] of staged) {
        if (kind === 'create' && rows.has(path)) throw new Error('already exists');
        rows.set(path, kind === 'update' ? { ...rows.get(path), ...data } : data);
      }
      return result;
    },
  } as unknown as Firestore;
  return { db, rows };
}
const owner = { uid: 'u1', email: 'owner@example.com' };
let n = 0;
const deps = (db: Firestore) => ({ db, generateKey: () => `rcv_key${++n}`, hashKey: (k: string) => `hash-of-${k}` });
const key = (label: string, extra: Row = {}): Row => ({ ownerUid: 'u1', ownerEmail: 'owner@example.com', label, scopes: ['receipts:read'], createdAt: null, createdBy: 'issue-key-script', ...extra });

test('only the verified owner may manage', () => {
  expect(isOwner({ token: { email: 'owner@example.com', email_verified: true } })).toBe(true);
  expect(isOwner({ token: { email: 'owner@example.com', email_verified: false } })).toBe(false);
  expect(isOwner({ token: { email: 'member1@example.com', email_verified: true } })).toBe(false);
  expect(isOwner(undefined)).toBe(false);
});

test('request parsing rejects unknown actions and bad values', () => {
  expect(parseManageRequest({ action: 'list' })).toEqual({ ok: true, req: { action: 'list' } });
  expect(parseManageRequest({ action: 'issue', label: ' hark ', organize: true })).toEqual({ ok: true, req: { action: 'issue', label: 'hark', organize: true } });
  for (const bad of [null, {}, { action: 'drop' }, { action: 'issue', label: '', organize: true }, { action: 'issue', label: 'a'.repeat(41), organize: false },
    { action: 'issue', label: 'x\ny', organize: false }, { action: 'issue', label: 'x', organize: 'yes' }, { action: 'revoke', keyId: '../x' }, { action: 'setWrite', enabled: 'true' }]) {
    expect(parseManageRequest(bad).ok).toBe(false);
  }
});

test('list returns metadata and the write switch, never key material', async () => {
  const { db } = fakeDb({ 'mcp_keys/h1': key('claude-read'), 'mcp_keys/h2': key('old', { revokedAt: 1 }), 'mcp_settings/receipts_write': { enabled: true } });
  const result = (await runManage(deps(db), { action: 'list' }, owner)) as { writeEnabled: boolean; keys: KeySummary[] };
  expect(result).toMatchObject({ writeEnabled: true });
  expect(result.keys).toEqual(expect.arrayContaining([
    expect.objectContaining({ keyId: 'h1', label: 'claude-read', scopes: ['receipts:read'], revoked: false }),
    expect.objectContaining({ keyId: 'h2', revoked: true }),
  ]));
  expect(JSON.stringify(result)).not.toContain('rcv_');
});

test('issue stores only the hash, returns the key once, and gives organize keys read too', async () => {
  const { db, rows } = fakeDb();
  const result = (await runManage(deps(db), { action: 'issue', label: 'hark-write', organize: true }, owner)) as { key: string };
  expect(result.key).toMatch(/^rcv_key/);
  const stored = rows.get(`mcp_keys/hash-of-${result.key}`)!;
  expect(stored).toMatchObject({ ownerUid: 'u1', ownerEmail: 'owner@example.com', label: 'hark-write', scopes: ['receipts:read', 'receipts:organize'], createdBy: 'web' });
  expect(JSON.stringify(stored)).not.toContain(result.key);
});

test('issue refuses a duplicate active label but allows reuse of a revoked one', async () => {
  const { db } = fakeDb({ 'mcp_keys/h1': key('hark'), 'mcp_keys/h2': key('old', { revokedAt: 1 }) });
  await expect(runManage(deps(db), { action: 'issue', label: 'hark', organize: false }, owner)).rejects.toMatchObject({ code: 'duplicate_label' });
  await expect(runManage(deps(db), { action: 'issue', label: 'old', organize: false }, owner)).resolves.toMatchObject({ label: 'old' });
});

test('setOrganize changes scopes on active keys only', async () => {
  const { db, rows } = fakeDb({ 'mcp_keys/h1': key('claude-read'), 'mcp_keys/h2': key('old', { revokedAt: 1 }) });
  await runManage(deps(db), { action: 'setOrganize', keyId: 'h1', organize: true }, owner);
  expect(rows.get('mcp_keys/h1')!.scopes).toEqual(['receipts:read', 'receipts:organize']);
  await runManage(deps(db), { action: 'setOrganize', keyId: 'h1', organize: false }, owner);
  expect(rows.get('mcp_keys/h1')!.scopes).toEqual(['receipts:read']);
  await expect(runManage(deps(db), { action: 'setOrganize', keyId: 'h2', organize: true }, owner)).rejects.toMatchObject({ code: 'revoked' });
  await expect(runManage(deps(db), { action: 'setOrganize', keyId: 'nope', organize: true }, owner)).rejects.toMatchObject({ code: 'not_found' });
});

test('revoke is permanent and repeatable; another owner\'s key is not found', async () => {
  const { db, rows } = fakeDb({ 'mcp_keys/h1': key('claude-read'), 'mcp_keys/h3': key('x', { ownerEmail: 'member1@example.com' }) });
  await expect(runManage(deps(db), { action: 'revoke', keyId: 'h1' }, owner)).resolves.toMatchObject({ revoked: true, already: false });
  expect(rows.get('mcp_keys/h1')!.revokedAt).toBeDefined();
  await expect(runManage(deps(db), { action: 'revoke', keyId: 'h1' }, owner)).resolves.toMatchObject({ revoked: true, already: true });
  await expect(runManage(deps(db), { action: 'revoke', keyId: 'h3' }, owner)).rejects.toBeInstanceOf(ManageError);
});

test('setWrite flips the kill switch', async () => {
  const { db, rows } = fakeDb();
  await runManage(deps(db), { action: 'setWrite', enabled: true }, owner);
  expect(rows.get('mcp_settings/receipts_write')).toMatchObject({ enabled: true });
  await runManage(deps(db), { action: 'setWrite', enabled: false }, owner);
  expect(rows.get('mcp_settings/receipts_write')).toMatchObject({ enabled: false });
});
