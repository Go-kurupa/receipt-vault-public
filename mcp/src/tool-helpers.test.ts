import { beforeEach, expect, test, vi } from 'vitest';
const log = vi.hoisted(() => vi.fn());
vi.mock('firebase-functions', () => ({ logger: { info: log } }));
import { runTool, toolResult } from './tool-helpers';
const ctx = { uid: 'u', email: 'owner@example.com', keyId: '12345678rest-of-hash', keyLabel: 'unknown', scopes: ['receipts:read'] as const };
beforeEach(() => log.mockClear());
test('one usage line with rows and no full key', async () => {
  const result = toolResult('結果', { rows: [1, 2] });
  expect(await runTool('dummy', ctx, async () => result)).toBe(result);
  expect(log).toHaveBeenCalledExactlyOnceWith('mcp: tool', {
    tool: 'dummy',
    keyIdPrefix: '12345678',
    durationMs: expect.any(Number),
    ok: true,
    rows: 2,
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain(ctx.keyId);
});
test('errors are short Japanese text without internals', async () => {
  const result = await runTool('dummy', ctx, async () => {
    throw new Error('secret internals');
  });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain('secret internals');
  expect(log).toHaveBeenCalledExactlyOnceWith('mcp: tool', {
    tool: 'dummy',
    keyIdPrefix: '12345678',
    durationMs: expect.any(Number),
    ok: false,
  });
});
