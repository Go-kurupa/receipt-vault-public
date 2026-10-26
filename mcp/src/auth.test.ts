import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), doc: vi.fn(), getUser: vi.fn(), write: vi.fn() }));
vi.mock('./admin', () => ({
  db: { doc: mocks.doc },
  adminAuth: { getUser: mocks.getUser },
}));
import { authenticateMcpRequest, McpAuthError } from './auth';
import { hashMcpKey } from './keys-pure';
const key = 'rcv_' + 'A'.repeat(43);
const data: Record<string, unknown> = { ownerUid: 'uid', ownerEmail: 'owner@example.com', scopes: ['receipts:read'] };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.doc.mockReturnValue({
    get: mocks.get,
    set: mocks.write,
    update: mocks.write,
    create: mocks.write,
  });
  mocks.get.mockResolvedValue({ exists: true, data: () => data });
  mocks.getUser.mockResolvedValue({ uid: 'uid', email: 'OWNER@example.com', disabled: false });
});
test.each([
  ['unknown_key', 401, () => mocks.get.mockResolvedValue({ exists: false })],
  [
    'revoked',
    401,
    () =>
      mocks.get.mockResolvedValue({
        exists: true,
        data: () => ({ ...data, revokedAt: new Date() }),
      }),
  ],
  ['disabled', 403, () => mocks.getUser.mockRejectedValue({ code: 'auth/user-not-found' })],
  [
    'disabled',
    403,
    () => mocks.getUser.mockResolvedValue({ disabled: true, email: 'owner@example.com' }),
  ],
  [
    'not_allowed',
    403,
    () => mocks.getUser.mockResolvedValue({ disabled: false, email: 'other@example.com' }),
  ],
  [
    'not_allowed',
    403,
    () =>
      mocks.get.mockResolvedValue({
        exists: true,
        data: () => ({ ...data, ownerEmail: 'staff@example.com' }),
      }),
  ],
] as const)('%s fails closed', async (reason, status, setup) => {
  setup();
  await expect(authenticateMcpRequest(`Bearer ${key}`, 'receipts:read')).rejects.toMatchObject({ reason, status });
  expect(mocks.write).not.toHaveBeenCalled();
});
test('missing key and successful read-only authentication', async () => {
  await expect(authenticateMcpRequest(undefined, 'receipts:read')).rejects.toBeInstanceOf(McpAuthError);
  await expect(authenticateMcpRequest(`Bearer ${key}`, 'receipts:read')).resolves.toEqual({
    uid: 'uid',
    email: 'owner@example.com',
    keyId: hashMcpKey(key),
    keyLabel: 'unknown',
    scopes: ['receipts:read'],
  });
  expect(mocks.doc).toHaveBeenCalledWith(`mcp_keys/${hashMcpKey(key)}`);
  expect(mocks.write).not.toHaveBeenCalled();
});
test('infrastructure errors remain unexpected errors', async () => {
  mocks.getUser.mockRejectedValue(new Error('network error'));
  await expect(authenticateMcpRequest(key, 'receipts:read')).rejects.toThrow('network error');
});

test.each(['rcv_abc', 'rcv_' + 'A'.repeat(44), 'rcv_' + 'A'.repeat(42) + '+'])(
  'invalid format never reads DB',
  async (header) => {
    await expect(authenticateMcpRequest(header, 'receipts:read')).rejects.toMatchObject({ reason: 'no_key' });
    expect(mocks.doc).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
  }
);
test.each([null, undefined])('nullish revocation is active', async (revokedAt) => {
  mocks.get.mockResolvedValue({ exists: true, data: () => ({ ...data, revokedAt }) });
  await expect(authenticateMcpRequest(key, 'receipts:read')).resolves.toMatchObject({ uid: 'uid' });
});
test.each([false, 0, '', {}])('non-null revocation fails closed', async (revokedAt) => {
  mocks.get.mockResolvedValue({ exists: true, data: () => ({ ...data, revokedAt }) });
  await expect(authenticateMcpRequest(key, 'receipts:read')).rejects.toMatchObject({ reason: 'revoked' });
  expect(mocks.getUser).not.toHaveBeenCalled();
});
