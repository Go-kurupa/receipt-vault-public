import { expect, test, vi } from 'vitest';
vi.mock('firebase-functions', () => ({ logger: { info: vi.fn() } }));
import { boundedResult, MAX_STRUCTURED_BYTES, structuredBytes } from './result-size';

test('serialized byte cap includes UTF-8 and refuses oversized scalar data', () => {
  const small = { memo: '日'.repeat(100) };
  expect(structuredBytes(small)).toBe(Buffer.byteLength(JSON.stringify(small)));
  expect(boundedResult('summary', small).structuredContent).toEqual(small);
  const large = { memo: '日'.repeat(MAX_STRUCTURED_BYTES) };
  const result = boundedResult('summary', large);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(large.memo);
});

test('上限は応答全体（文章と構造化データの両方）で判定する', () => {
  const data = { memo: 'a'.repeat(110_000) };
  expect(structuredBytes(data)).toBeLessThan(MAX_STRUCTURED_BYTES);
  expect(boundedResult('summary', data).isError).toBe(true);
});
