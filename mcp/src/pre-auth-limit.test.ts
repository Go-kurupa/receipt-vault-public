import { expect, test } from 'vitest';
import { createPreAuthLimiter } from './pre-auth-limit';

test('total cap is 120 in a sliding 60 second window, including blocked requests', () => {
  let now = 0;
  const limiter = createPreAuthLimiter(() => now);
  for (let i = 0; i < 60; i++) expect(limiter.allow(null)).toBe(true);
  now = 30_000;
  for (let i = 0; i < 60; i++) expect(limiter.allow(`attacker-${i}`)).toBe(true);
  expect(limiter.allow(null)).toBe(false);
  now = 60_000;
  for (let i = 0; i < 60; i++) expect(limiter.allow(null)).toBe(true);
  expect(limiter.allow(null)).toBe(false);
  now = 90_000;
  expect(limiter.allow(null)).toBe(true);
});

test('more than 30 failures blocks unknown keys but still authenticates known-good keys', () => {
  let now = 0;
  const limiter = createPreAuthLimiter(() => now);
  limiter.recordSuccess('good');
  for (let i = 0; i < 30; i++) limiter.recordFailure();
  expect(limiter.allow('unknown')).toBe(true);
  limiter.recordFailure();
  expect(limiter.allow(null)).toBe(false);
  expect(limiter.allow('unknown')).toBe(false);
  expect(limiter.allow('good')).toBe(true);
  now = 60_000;
  expect(limiter.allow('unknown')).toBe(true);
});

test('known-good entries expire 10 minutes after authentication and use LRU eviction', () => {
  let now = 0;
  const limiter = createPreAuthLimiter(() => now);
  for (let i = 0; i < 16; i++) limiter.recordSuccess(`good-${i}`);
  limiter.recordSuccess('good-0');
  limiter.recordSuccess('new');
  for (let i = 0; i < 31; i++) limiter.recordFailure();
  expect(limiter.allow('good-1')).toBe(false);
  expect(limiter.allow('good-0')).toBe(true);
  now = 599_999;
  for (let i = 0; i < 31; i++) limiter.recordFailure();
  expect(limiter.allow('good-0')).toBe(true);
  now = 600_000;
  expect(limiter.allow('good-0')).toBe(false);
});

test('all structures are bounded regardless of attacker input or authentication volume', () => {
  const limiter = createPreAuthLimiter(() => 0);
  for (let i = 0; i < 10_000; i++) {
    limiter.allow(`attacker-${i}`);
    limiter.recordFailure();
    limiter.recordSuccess(`authenticated-${i}`);
  }
  expect(limiter.sizes()).toEqual({ requests: 120, failures: 31, knownGood: 16 });
});
