import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import express from 'express';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), allow: vi.fn() }));
vi.mock('./auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth')>()),
  authenticateMcpRequest: mocks.auth,
}));
vi.mock('./admin', () => ({ db: {}, adminAuth: {} }));
vi.mock('./rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rate-limit')>()),
  allowMcpRequest: mocks.allow,
}));
import { createMcpHandler } from './http';
import { buildReceiptsMcpServer } from './server';
import type { ToolRegistrar } from './server';
import { preAuthLimiter } from './pre-auth-limit';
const handlerFor = (registrars: readonly ToolRegistrar[] = [], limiter = preAuthLimiter) => createMcpHandler({ requiredScope: 'receipts:read', buildServer: (ctx) => buildReceiptsMcpServer(ctx, registrars), limiter });
import { McpAuthError } from './auth';
import { readOnly, toolResult } from './tool-helpers';
let http: Server;
let url: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.all(
    '/mcp',
    handlerFor([
      (s) =>
        s.registerTool('dummy', { annotations: readOnly }, async () =>
          toolResult('結果', { rows: 1 })
        ),
    ])
  );
  http = createServer(app);
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  url = `http://127.0.0.1:${address.port}/mcp`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});
test.each(['GET', 'DELETE'])('%s returns 405', async (method) => {
  const response = await fetch(url, { method });
  expect(response.status).toBe(405);
  expect(response.headers.get('allow')).toBe('POST');
});
async function post(body: object) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer rcv_mock',
    },
    body: JSON.stringify(body),
  });
}
test('auth errors and unexpected failure', async () => {
  mocks.auth.mockRejectedValueOnce(new McpAuthError(401, '接続キーがありません', 'no_key'));
  const response = await fetch(url, { method: 'POST' });
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    jsonrpc: '2.0',
    error: { code: -32001 },
    id: null,
  });
  mocks.auth.mockRejectedValueOnce(new Error('sensitive internal details'));
  const failure = await post({});
  expect(failure.status).toBe(500);
  expect(await failure.json()).toMatchObject({
    error: { code: -32603, message: 'internal error' },
  });
});
test('rate limited', async () => {
  mocks.auth.mockResolvedValue({ uid: 'u', email: 'owner@example.com', keyId: 'hash' });
  mocks.allow.mockReturnValue(false);
  const response = await post({});
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({
    error: { code: -32002, message: '呼び出し回数の上限です。1分ほど待ってから再度お試しください' },
  });
});
test('real stateless HTTP 2025-11-25 initialize -> notification -> tool', async () => {
  mocks.auth.mockResolvedValue({ uid: 'u', email: 'owner@example.com', keyId: 'hash', keyLabel: 'unknown', scopes: ['receipts:read'] });
  mocks.allow.mockReturnValue(true);
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'Hark-test', version: '1' },
    },
  });
  expect(init.status).toBe(200);
  expect(init.headers.get('mcp-session-id')).toBeNull();
  expect(await init.json()).toMatchObject({
    result: { protocolVersion: '2025-11-25', instructions: expect.any(String) },
  });
  const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  expect(notification.status).toBe(202);
  const result = await post({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'dummy', arguments: {} },
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    result: {
      content: [{ type: 'text', text: '結果\n{"rows":1}' }],
      structuredContent: { rows: 1 },
    },
  });
});

test('wrong scope returns 403', async () => {
  mocks.auth.mockRejectedValueOnce(new McpAuthError(403, 'この接続キーはこの窓口では使えません', 'scope'));
  expect((await post({})).status).toBe(403);
});
