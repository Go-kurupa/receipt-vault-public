import { expect, test, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { isReceiptsWriteEnabled } from './kill-switch';
test.each([undefined, {}, { enabled: 'true' }, { enabled: 1 }, { enabled: false }, { enabled: true }])('only exact true enables writes: %j', async data => {
  const doc = vi.fn(() => ({ get: async () => ({ exists: data !== undefined, data: () => data }) }));
  expect(await isReceiptsWriteEnabled({ doc } as unknown as Firestore)).toBe(data?.enabled === true);
  expect(doc).toHaveBeenCalledWith('mcp_settings/receipts_write');
});
test('unreadable setting fails closed', async () => {
  expect(await isReceiptsWriteEnabled({ doc: () => ({ get: async () => { throw new Error('sensitive'); } }) } as unknown as Firestore)).toBe(false);
});
