import { expect, test, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { buildReceiptDoc } from '../../../functions/src/versioning';
vi.mock('../admin', () => ({ db: {}, adminAuth: {} }));
import { createDraft, applyDraft, DRAFT_TTL_MS } from './organize-store';
const v1 = { ...buildReceiptDoc({ kind: 'paper', receiptDate: '2026-10-01', receivedDate: '2026-10-01', amount: 100, vendor: '店', category: null, memo: null, project: null, businessRatio: 100, source: 'discord' }, { chainId: 'c1', storagePath: 'file', sha256: 'hash', mimeType: 'image/jpeg', resolutionOk: true }), registeredAt: { toDate: () => new Date(0) } };
// Stages creates, rejects reads after writes, and rolls back failures like Firestore.
function fakeDb(initial: Record<string, unknown> = v1, failLog = false) {
  let attempts = 0;
  const rows = new Map<string, Record<string, unknown>>([['receipts/d1', initial], ['mcp_settings/receipts_write', { enabled: true }]]);
  const snap = (path: string) => {
    const data = rows.get(path);
    return { id: path.split('/')[1], exists: data !== undefined, data: () => data };
  };
  const db = {
    doc: (path: string) => ({ path }),
    collection: (name: string) => ({ where: (field: string, op: string, value: string) => {
      expect([name, field, op]).toEqual(['receipts', 'chainId', '==']);
      return { orderBy: (order: string, dir: string) => {
        expect([order, dir]).toEqual(['version', 'desc']);
        return { limit: (n: number) => { expect(n).toBe(1); return { query: value }; } };
      } };
    } }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      for (let retry = 0; retry < 5; retry++) {
      attempts++;
      const before = new Map(rows);
      const pending = new Map<string, Record<string, unknown>>();
      const result = await fn({
        get: async (ref: { path?: string; query?: string }) => {
          if (pending.size) throw new Error('read after write');
          if (ref.path) return snap(ref.path);
          const paths = [...rows.keys()].filter(p => p.startsWith('receipts/') && rows.get(p)?.chainId === ref.query && rows.get(p)?.version !== undefined).sort((a, b) => Number(rows.get(b)?.version) - Number(rows.get(a)?.version)).slice(0, 1);
          return { empty: !paths.length, docs: paths.map(snap) };
        },
        create: (ref: { path: string }, data: Record<string, unknown>) => {
          if (failLog && ref.path.startsWith('requestLog/')) throw new Error('log create failed');
          if (pending.has(ref.path)) throw new Error('duplicate create');
          pending.set(ref.path, data);
        },
      });
      // Retry if a concurrent transaction committed since this attempt began.
      if (rows.size !== before.size || [...rows].some(([p, data]) => before.get(p) !== data)) continue;
      for (const path of pending.keys()) if (rows.has(path)) throw new Error('already exists');
      for (const [path, data] of pending) rows.set(path, data);
      return result;
      }
      throw new Error('transaction retry exhausted');
    },
  } as unknown as Firestore;
  return { db, rows, attempts: () => attempts, count: () => [...rows.keys()].filter(p => p.startsWith('receipts/')).length };
}
const preview = (db: Firestore) => createDraft(db, { keyId: 'key-one-full', chainId: 'c1', patch: { status: '記帳済', memo: '私的なメモ' }, now: 0 });
const apply = (db: Firestore, draftId: string, over = {}) => applyDraft(db, { keyId: 'key-one-full', keyLabel: 'claude-write', draftId, now: 1, ...over });
test('creates a ten-minute draft, then appends one version and an attribution log only', async () => {
  const { db, rows, count } = fakeDb();
  const { draftId, changes } = await preview(db);
  expect(rows.get(`mcp_drafts/${draftId}`)).toMatchObject({ keyId: 'key-one-full', baseDocId: 'd1', baseVersion: 1, expiresAt: DRAFT_TTL_MS });
  expect(changes.map(c => c.field)).toEqual(['status', 'memo']);
  const result = await apply(db, draftId);
  expect(result).toMatchObject({ chainId: 'c1', version: 2, replayed: false });
  expect(count()).toBe(2);
  const version = rows.get(`receipts/${result.docId}`)!;
  expect(Object.keys(version).sort()).toEqual(Object.keys(v1).sort());
  expect(version).toMatchObject({ source: 'discord', prevVersionId: 'd1', memo: '私的なメモ' });
  expect(version.registeredAt).not.toBe('__SERVER_TIMESTAMP__');
  expect(rows.get(`requestLog/${draftId}`)).toMatchObject({ fn: 'mcpOrganizeApply', via: 'mcp', keyId: 'key-one-', keyLabel: 'claude-write', ownerEmail: 'owner@example.com', fields: ['status', 'memo'], result: { ok: true, docId: result.docId } });
  expect(rows.has(`mcp_drafts/${draftId}`)).toBe(true);
});
test('refuses when another channel added a version after the draft', async () => {
  const { db, rows, count } = fakeDb();
  const { draftId } = await preview(db);
  rows.set('receipts/other', { ...v1, version: 2 });
  await expect(apply(db, draftId)).rejects.toMatchObject({ code: 'conflict' });
  expect(count()).toBe(2);
  expect(rows.has(`requestLog/${draftId}`)).toBe(false);
});
test('doc ID change with the same version also conflicts', async () => {
  const { db, rows } = fakeDb(); const { draftId } = await preview(db);
  rows.delete('receipts/d1'); rows.set('receipts/other', v1);
  await expect(apply(db, draftId)).rejects.toMatchObject({ code: 'conflict' });
});
test('replays the same result without another version, including after expiration', async () => {
  const { db, count } = fakeDb(); const { draftId } = await preview(db);
  const first = await apply(db, draftId);
  expect(await apply(db, draftId, { now: DRAFT_TTL_MS + 1 })).toEqual({ ...first, replayed: true });
  expect(count()).toBe(2);
});
test.each([false, true])('rejects other keys before and after apply (%s)', async applied => {
  const { db, count } = fakeDb(); const { draftId } = await preview(db);
  if (applied) await apply(db, draftId);
  // Prefix collision must not authorize a different key.
  await expect(apply(db, draftId, { keyId: 'key-one-other' })).rejects.toMatchObject({ code: 'draft_other_key' });
  expect(count()).toBe(applied ? 2 : 1);
});
test('rejects expired drafts but accepts the exact expiry boundary', async () => {
  const { db } = fakeDb(); const { draftId } = await preview(db);
  await expect(apply(db, draftId, { now: DRAFT_TTL_MS + 1 })).rejects.toMatchObject({ code: 'draft_expired' });
  await expect(apply(db, draftId, { now: DRAFT_TTL_MS })).resolves.toMatchObject({ version: 2 });
});
test('rejects missing drafts and unrelated request logs', async () => {
  const { db, rows } = fakeDb();
  await expect(apply(db, 'missing')).rejects.toMatchObject({ code: 'draft_missing' });
  const { draftId } = await preview(db);
  rows.set(`requestLog/${draftId}`, { fn: 'correctReceipt' });
  await expect(apply(db, draftId)).rejects.toMatchObject({ code: 'conflict' });
});
test.each(['not_found', 'deleted', 'broken', 'no_change'])('does not create a draft: %s', async code => {
  const { db, rows } = fakeDb(code === 'deleted' ? { ...v1, deleted: true } : code === 'broken' ? { ...v1, storagePath: undefined } : v1);
  if (code === 'not_found') rows.clear();
  await expect(createDraft(db, { keyId: 'k', chainId: 'c1', patch: { status: '未記帳' }, now: 0 })).rejects.toMatchObject({ code });
  expect([...rows.keys()].some(p => p.startsWith('mcp_drafts/'))).toBe(false);
});
test.each(['deleted', 'broken'])('rejects invalid current receipt during apply: %s', async code => {
  const { db, rows, count } = fakeDb(); const { draftId } = await preview(db);
  rows.set('receipts/d1', code === 'deleted' ? { ...v1, deleted: true } : { ...v1, amount: undefined });
  await expect(apply(db, draftId)).rejects.toMatchObject({ code });
  expect(count()).toBe(1);
});
test.each(Object.keys(v1))('missing required receipt field is broken: %s', async field => {
  const data: Record<string, unknown> = { ...v1 }; delete data[field];
  const { db } = fakeDb(data);
  await expect(preview(db)).rejects.toMatchObject({ code: field === 'chainId' || field === 'version' ? 'not_found' : 'broken' });
});

test('reports only changed field names after commit, also on replay', async () => {
  const { db, rows } = fakeDb(); const { draftId } = await preview(db);
  const audit = vi.fn((fields: string[]) => {
    expect(rows.has(`requestLog/${draftId}`)).toBe(true);
    expect(fields).toEqual(['status', 'memo']);
  });
  const args = { keyId: 'key-one-full', keyLabel: 'write', draftId, now: 1 };
  await applyDraft(db, args, audit);
  await applyDraft(db, args, audit);
  expect(audit).toHaveBeenCalledTimes(2);
});

test('simultaneous applies retry safely and append only one version', async () => {
  const { db, count, attempts } = fakeDb(); const { draftId } = await preview(db);
  const [a, b] = await Promise.all([apply(db, draftId), apply(db, draftId)]);
  expect(a.docId).toBe(b.docId);
  expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  expect(count()).toBe(2);
  expect(attempts()).toBeGreaterThan(3);
});
test('failure to create request log rolls back receipt creation too', async () => {
  const { db, rows, count } = fakeDb(v1, true); const { draftId } = await preview(db);
  const audit = vi.fn();
  await expect(applyDraft(db, { keyId: 'key-one-full', keyLabel: 'write', draftId, now: 1 }, audit)).rejects.toThrow('log create failed');
  expect(count()).toBe(1);
  expect(rows.has(`requestLog/${draftId}`)).toBe(false);
  expect(audit).not.toHaveBeenCalled();
});
test('canonical draft hash is independent of patch key order', async () => {
  const { db, rows } = fakeDb(); const { draftId } = await preview(db);
  const first = await apply(db, draftId);
  const draft = rows.get(`mcp_drafts/${draftId}`)!;
  rows.set(`mcp_drafts/${draftId}`, { ...draft, patch: { memo: '私的なメモ', status: '記帳済' } });
  expect(await apply(db, draftId)).toEqual({ ...first, replayed: true });
  expect(rows.get(`requestLog/${draftId}`)?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
});
test.each([
  { patch: { amount: 5 } }, { patch: {} }, { expiresAt: 'future' }, { baseVersion: null },
])('invalid stored draft fails closed: %j', async over => {
  const { db, rows, count } = fakeDb(); const { draftId } = await preview(db);
  rows.set(`mcp_drafts/${draftId}`, { ...rows.get(`mcp_drafts/${draftId}`)!, ...over });
  await expect(apply(db, draftId)).rejects.toMatchObject({ code: 'broken' });
  expect(count()).toBe(1);
});
test.each([{ payloadHash: 'wrong' }, { result: { ok: false } }, { fields: ['unexpected'] }])('invalid request log cannot be replayed: %j', async over => {
  const { db, rows, count } = fakeDb(); const { draftId } = await preview(db);
  await apply(db, draftId);
  rows.set(`requestLog/${draftId}`, { ...rows.get(`requestLog/${draftId}`)!, ...over });
  await expect(apply(db, draftId)).rejects.toMatchObject({ code: 'conflict' });
  expect(count()).toBe(2);
});

test('refuses to write when the switch is turned off before the transaction reads it', async () => {
  const { db, rows, count } = fakeDb();
  const { draftId } = await preview(db);
  rows.set('mcp_settings/receipts_write', { enabled: false });
  await expect(apply(db, draftId)).rejects.toMatchObject({ code: 'disabled' });
  rows.set('mcp_settings/receipts_write', { enabled: 'true' });
  await expect(apply(db, draftId)).rejects.toMatchObject({ code: 'disabled' });
  rows.delete('mcp_settings/receipts_write');
  await expect(apply(db, draftId)).rejects.toMatchObject({ code: 'disabled' });
  expect(count()).toBe(1);
  expect([...rows.keys()].some(p => p.startsWith('requestLog/'))).toBe(false);
});
