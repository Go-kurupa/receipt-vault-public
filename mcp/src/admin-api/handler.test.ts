import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), info: vi.fn() }));
vi.mock('../admin', () => ({ db: {}, adminAuth: {} }));
vi.mock('firebase-functions', () => ({ logger: { info: mocks.info } }));
vi.mock('./manage', async (original) => ({ ...(await original<typeof import('./manage')>()), runManage: mocks.run }));
import { handleManage } from './handler';
import { ManageError } from './manage';
import type { CallableRequest } from 'firebase-functions/v2/https';

const FAKE_KEY = 'rcv_' + 'Z'.repeat(43);
const call = (data: unknown, token: Record<string, unknown> | null = { email: 'owner@example.com', email_verified: true }) =>
  handleManage({ data, auth: token ? { uid: 'u1', token } : undefined } as unknown as CallableRequest<unknown>);
beforeEach(() => vi.resetAllMocks());

test('rejects anyone but the verified owner before doing anything', async () => {
  await expect(call({ action: 'list' }, null)).rejects.toMatchObject({ code: 'permission-denied' });
  await expect(call({ action: 'list' }, { email: 'member2@example.com', email_verified: true })).rejects.toMatchObject({ code: 'permission-denied' });
  await expect(call({ action: 'list' }, { email: 'owner@example.com', email_verified: false })).rejects.toMatchObject({ code: 'permission-denied' });
  expect(mocks.run).not.toHaveBeenCalled();
});

test('maps domain errors and never logs key material', async () => {
  mocks.run.mockResolvedValueOnce({ key: FAKE_KEY, keyIdPrefix: 'abcd1234', label: 'h', scopes: [] });
  await expect(call({ action: 'issue', label: 'h', organize: false })).resolves.toMatchObject({ key: FAKE_KEY });
  mocks.run.mockRejectedValueOnce(new ManageError('duplicate_label', 'dup'));
  await expect(call({ action: 'issue', label: 'h', organize: false })).rejects.toMatchObject({ code: 'already-exists' });
  mocks.run.mockRejectedValueOnce(new Error(FAKE_KEY + ' internal'));
  await expect(call({ action: 'revoke', keyId: 'abcdef123456' })).rejects.toMatchObject({ code: 'internal' });
  expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('ZZZZ');
  expect(mocks.info).toHaveBeenLastCalledWith('ai_connections_manage', { action: 'revoke', keyId: 'abcdef12', result: 'error' });
});
