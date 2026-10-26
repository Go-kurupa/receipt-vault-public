import { expect, test } from 'vitest';
import { parseKeyScopes } from './scopes';
test.each([undefined, [], ['dashboard']])('rejects %j', (raw) => {
  expect(parseKeyScopes(raw)).toBeNull();
});
test('accepts receipts:read', () => {
  expect(parseKeyScopes(['receipts:read'])).toEqual(['receipts:read']);
});
