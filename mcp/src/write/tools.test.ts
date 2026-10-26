import { beforeEach, expect, test, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Firestore } from 'firebase-admin/firestore';
const mocks = vi.hoisted(() => ({ create: vi.fn(), apply: vi.fn(), enabled: vi.fn(), info: vi.fn(), get: vi.fn(), getUser: vi.fn() }));
vi.mock('../admin', () => ({ db: { doc: () => ({ get: mocks.get }) }, adminAuth: { getUser: mocks.getUser } }));
vi.mock('firebase-functions', () => ({ logger: { info: mocks.info } }));
vi.mock('./organize-store', async original => ({ ...await original<typeof import('./organize-store')>(), createDraft: mocks.create, applyDraft: mocks.apply }));
vi.mock('./kill-switch', () => ({ isReceiptsWriteEnabled: mocks.enabled }));
import { organizeRegistrars } from './tools';
import { buildReceiptsMcpServer } from '../server';
import { readRegistrars } from '../tools';
import { authenticateMcpRequest } from '../auth';
const ctx = { uid: 'u', email: 'owner@example.com', keyId: 'full-key-id', keyLabel: 'claude-write', scopes: ['receipts:read', 'receipts:organize'] as ('receipts:read' | 'receipts:organize')[] };
const key = 'rcv_' + 'A'.repeat(43);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.enabled.mockResolvedValue(true);
  mocks.create.mockResolvedValue({ draftId: 'draft', latest: { chainId: 'c1', vendor: '店', amount: 100, receiptDate: '2026-10-01' }, changes: [{ field: 'memo', before: null, after: 'secret-memo' }] });
  mocks.apply.mockImplementation(async (_db, _args, audit?: (fields: string[]) => void) => {
    audit?.(['memo']);
    return { chainId: 'c1', docId: 'd2', version: 2, replayed: false };
  });
  mocks.getUser.mockResolvedValue({ uid: 'u', email: ctx.email, disabled: false });
});
async function connect(c: typeof ctx = ctx) {
  const server = buildReceiptsMcpServer(c, readRegistrars(async () => { throw new Error('unused'); }), organizeRegistrars({ db: {} as Firestore, now: () => 100 }));
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
test('organize key authenticates with label; read-only key cannot enter write window', async () => {
  const data = { ownerUid: 'u', ownerEmail: ctx.email, label: ctx.keyLabel, scopes: ['receipts:read'] };
  mocks.get.mockResolvedValue({ exists: true, data: () => data });
  await expect(authenticateMcpRequest(`Bearer ${key}`, 'receipts:organize')).rejects.toMatchObject({ status: 403, reason: 'scope' });
  await expect(authenticateMcpRequest(undefined, 'receipts:organize')).rejects.toMatchObject({ status: 401 });
  mocks.get.mockResolvedValue({ exists: true, data: () => ({ ...data, scopes: ['receipts:organize'] }) });
  await expect(authenticateMcpRequest(key, 'receipts:organize')).resolves.toMatchObject({ keyLabel: 'claude-write' });
  mocks.get.mockResolvedValue({ exists: true, data: () => ({ ...data, scopes: ['receipts:organize'], label: 1 }) });
  await expect(authenticateMcpRequest(key, 'receipts:organize')).resolves.toMatchObject({ keyLabel: 'unknown' });
});
test('preview then apply works, carries instructions, annotations and cache delay note', async () => {
  const { client, close } = await connect();
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.map(t => t.name).sort()).toEqual(['apply_update_receipt', 'get_data_freshness', 'get_monthly_summary', 'get_receipt', 'list_unbooked', 'preview_update_receipt', 'search_receipts']);
    expect(tools.find(t => t.name === 'preview_update_receipt')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find(t => t.name === 'apply_update_receipt')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(client.getInstructions()).toContain('明確な了承');
    expect(client.getInstructions()).not.toContain('読み取り専用');
    const preview = await client.callTool({ name: 'preview_update_receipt', arguments: { chainId: 'c1', patch: { memo: ' secret-memo ' } } });
    expect(preview.structuredContent).toMatchObject({ status: 'ready', draftId: 'draft', chainId: 'c1', writeEnabled: true, warnings: [], expiresAt: 600100, appUrl: expect.stringContaining('?chain=c1') });
    expect(mocks.create).toHaveBeenCalledWith(expect.anything(), { keyId: ctx.keyId, chainId: 'c1', patch: { memo: 'secret-memo' }, now: 100 });
    const applied = await client.callTool({ name: 'apply_update_receipt', arguments: { draftId: 'draft' } });
    expect(applied.structuredContent).toMatchObject({ ok: true, chainId: 'c1', version: 2, replayed: false, note: '読み取り窓口への反映は最大 1 分遅れます' });
    expect(mocks.apply).toHaveBeenCalledWith(expect.anything(), { keyId: ctx.keyId, keyLabel: ctx.keyLabel, draftId: 'draft', now: 100 }, expect.any(Function));
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('secret-memo');
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(ctx.keyId);
    expect(mocks.info.mock.calls.map(c => c[0])).toEqual(['receipts_organize_preview', 'receipts_organize_apply']);
    expect(mocks.info).toHaveBeenCalledWith('receipts_organize_apply', { keyId: 'full-key', chainId: 'c1', fields: ['memo'], result: 'applied' });
  } finally { await close(); }
});
test('disabled writes still preview with warning, but never apply', async () => {
  mocks.enabled.mockResolvedValue(false);
  const { client, close } = await connect();
  try {
    const preview = await client.callTool({ name: 'preview_update_receipt', arguments: { chainId: 'c1', patch: { memo: 'x' } } });
    expect(preview.structuredContent).toMatchObject({ writeEnabled: false, warnings: ['書き込みは停止中です'] });
    expect((await client.callTool({ name: 'apply_update_receipt', arguments: { draftId: 'draft' } })).isError).toBe(true);
    expect(mocks.apply).not.toHaveBeenCalled();
  } finally { await close(); }
});
test.each([{ amount: 5 }, {}, { memo: 'a'.repeat(501) }, { journalNo: '\n123' }])('invalid patch %j never creates a draft', async patch => {
  const { client, close } = await connect();
  try {
    expect((await client.callTool({ name: 'preview_update_receipt', arguments: { chainId: 'c1', patch } })).isError).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
  } finally { await close(); }
});
test('safe errors explain conflicts; unexpected errors never expose details', async () => {
  const { OrganizeError } = await import('./organize-store');
  mocks.apply.mockRejectedValueOnce(new OrganizeError('conflict', '下書きを作り直してください')).mockRejectedValueOnce(new Error('secret-memo'));
  const { client, close } = await connect();
  try {
    const first = await client.callTool({ name: 'apply_update_receipt', arguments: { draftId: 'draft' } });
    expect(JSON.stringify(first.content)).toContain('下書きを作り直してください');
    const second = await client.callTool({ name: 'apply_update_receipt', arguments: { draftId: 'draft' } });
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second)).not.toContain('secret-memo');
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('secret-memo');
  } finally { await close(); }
});

test.each([
  { chainId: 'c1', patch: { status: 'secret-memo' } },
  { chainId: 'c1', patch: { businessRatio: 'secret-memo' } },
  { chainId: 'c1', patch: { category: ['secret-memo'] } },
  { chainId: 'secret-memo!', patch: { memo: 'x' } },
])('malformed input %j is rejected without echoing the value', async args => {
  const { client, close } = await connect();
  try {
    const result = await client.callTool({ name: 'preview_update_receipt', arguments: args }).catch((error: unknown) => ({ isError: true, thrown: String(error) }));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret-memo');
    expect(mocks.create).not.toHaveBeenCalled();
  } finally { await close(); }
});

test('a read-only key sees only read tools and read-only instructions', async () => {
  const { client, close } = await connect({ ...ctx, keyLabel: 'claude-read', scopes: ['receipts:read'] });
  try {
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).not.toContain('preview_update_receipt');
    expect(names).not.toContain('apply_update_receipt');
    expect(names).toHaveLength(5);
    expect(client.getInstructions()).toContain('読み取り専用');
    expect(client.getInstructions()).not.toContain('apply_update_receipt');
  } finally { await close(); }
});
