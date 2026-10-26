import { expect, test } from 'vitest';
import { selectActiveKey } from './key-scopes';
const doc = (id: string, data: Record<string, unknown>) => ({ id, data: () => data });
test('treats revokedAt null like auth does (active)', () => {
  expect(selectActiveKey([doc('a', { revokedAt: null })])?.id).toBe('a');
});
test('ignores revoked keys and refuses duplicates across null/missing revokedAt', () => {
  expect(selectActiveKey([doc('a', { revokedAt: { seconds: 1 } }), doc('b', {})])?.id).toBe('b');
  expect(selectActiveKey([doc('a', { revokedAt: null }), doc('b', {})])).toBeNull();
  expect(selectActiveKey([doc('a', { revokedAt: 1 })])).toBeNull();
});
