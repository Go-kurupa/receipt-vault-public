import { describe, expect, test } from 'vitest';
import {
  describeAuthorizationHeader,
  generateMcpKey,
  hashMcpKey,
  MCP_KEY_PREFIX,
  MCP_KEY_BODY_LENGTH,
  parseBearer,
} from './keys-pure';
describe('connection keys', () => {
  test('random 32 bytes and stable hash', () => {
    expect(MCP_KEY_BODY_LENGTH).toBe(43);
    for (let i = 0; i < 1000; i++) expect(generateMcpKey()).toMatch(/^rcv_[A-Za-z0-9_-]{43}$/);
    const key = generateMcpKey();
    expect(key.startsWith(MCP_KEY_PREFIX)).toBe(true);
    expect(key).toMatch(/^rcv_[A-Za-z0-9_-]{43}$/);
    expect(key.length).toBe(47);
    expect(generateMcpKey()).not.toBe(key);
    expect(hashMcpKey(key)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashMcpKey(key)).toBe(hashMcpKey(key));
  });
  test.each([
    'Bearer rcv_abc',
    'bearer   rcv_abc  ',
    'rcv_abc',
    'Bearer\u3000rcv_abc',
    'Bearerrcv_abc',
    'Bearer: rcv_abc',
    'Bearer：rcv_abc',
    'Bearer rcv_ab\nc',
    'Bearer "rcv_abc"',
    "Bearer 'rcv_abc'",
    'Bearer 「rcv_abc」',
    '\uFEFFBearer rcv_abc\u200B\u200C\u200D',
  ])('tolerates input %s', (header) => {
    expect(
      parseBearer(
        header.replace('abc', 'abc' + 'A'.repeat(40)).replace('ab\nc', 'ab\nc' + 'A'.repeat(40))
      )
    ).toBe('rcv_abc' + 'A'.repeat(40));
  });
  test.each([
    undefined,
    '',
    'Basic xxx',
    'Bearer ',
    'Bearer other_abc',
    'Bearer rcv_',
    'Basic rcv_abc',
    'rcv_abc',
    'rcv_' + 'A'.repeat(42),
    'rcv_' + 'A'.repeat(44),
    'rcv_' + 'A'.repeat(42) + '+',
    'rcv_' + 'A'.repeat(42) + '/',
    'rcv_' + 'A'.repeat(42) + '=',
    'rcv_' + 'A'.repeat(42) + 'あ',
  ])('rejects invalid input', (header) => {
    expect(parseBearer(header)).toBeNull();
  });
  test('logs shape only', () => {
    const shape = describeAuthorizationHeader('Bearer rcv_secretvalue123\n\u3000');
    expect(shape).toEqual({
      present: true,
      length: 27,
      hasBearerPrefix: true,
      hasNonAscii: true,
      hasNewline: true,
    });
    expect(JSON.stringify(shape)).not.toContain('secretvalue');
    expect(describeAuthorizationHeader(undefined)).toEqual({
      present: false,
      length: 0,
      hasBearerPrefix: false,
      hasNonAscii: false,
      hasNewline: false,
    });
  });
});
