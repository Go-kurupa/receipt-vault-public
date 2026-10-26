import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), doc: vi.fn(), getUser: vi.fn() }));
vi.mock('./admin', () => ({
  db: { doc: mocks.doc },
  adminAuth: { getUser: mocks.getUser },
}));
import { authenticateMcpRequest, McpAuthError } from './auth';
import { hashMcpKey } from './keys-pure';
import type { McpScope } from './scopes';

const key = 'rcv_' + 'A'.repeat(43);
const data = { ownerUid: 'uid', ownerEmail: 'owner@example.com' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.doc.mockReturnValue({ get: mocks.get });
  mocks.get.mockResolvedValue({ exists: true, data: () => data });
  mocks.getUser.mockResolvedValue({ uid: 'uid', email: 'OWNER@example.com', disabled: false });
});

test.each([
  [['receipts:read'], 'receipts:read'],
] as const)('scope %j allows %s', async (scopes, requiredScope) => {
  mocks.get.mockResolvedValue({ exists: true, data: () => ({ ...data, scopes }) });
  await expect(authenticateMcpRequest(`Bearer ${key}`, requiredScope)).resolves.toEqual({
    uid: 'uid',
    email: 'owner@example.com',
    keyId: hashMcpKey(key),
    keyLabel: 'unknown',
    scopes: ['receipts:read'],
  });
});

test.each([
  [undefined, 'receipts:read'],
  [['dashboard'], 'receipts:read'],
  ['receipts:read', 'receipts:read'],
] satisfies [unknown, McpScope][])('scope %j rejects %s', async (scopes, requiredScope) => {
  mocks.get.mockResolvedValue({ exists: true, data: () => ({ ...data, scopes }) });
  const result = authenticateMcpRequest(`Bearer ${key}`, requiredScope);
  await expect(result).rejects.toBeInstanceOf(McpAuthError);
  await expect(result).rejects.toMatchObject({
    status: 403,
    reason: 'scope',
    message: 'この接続キーはこの窓口では使えません',
  });
});

test('revocation is checked before matching scopes', async () => {
  mocks.get.mockResolvedValue({
    exists: true,
    data: () => ({ ...data, scopes: ['receipts:read'], revokedAt: new Date() }),
  });
  await expect(authenticateMcpRequest(`Bearer ${key}`, 'receipts:read')).rejects.toMatchObject({
    status: 401,
    reason: 'revoked',
  });
  expect(mocks.getUser).not.toHaveBeenCalled();
});
