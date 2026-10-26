import { expect, test } from 'vitest';
import { createRateLimiter } from './rate-limit';
test('60 per key and sliding window', () => {
  let now = 0;
  const allow = createRateLimiter(() => now);
  for (let i = 0; i < 30; i++) expect(allow('key')).toBe(true);
  now = 30_000;
  for (let i = 0; i < 30; i++) expect(allow('key')).toBe(true);
  expect(allow('key')).toBe(false);
  expect(allow('other')).toBe(true);
  now = 60_000;
  for (let i = 0; i < 30; i++) expect(allow('key')).toBe(true);
  expect(allow('key')).toBe(false);
  now = 90_000;
  expect(allow('key')).toBe(true);
});
