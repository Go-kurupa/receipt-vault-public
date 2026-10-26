import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  allow: vi.fn(),
  connect: vi.fn(),
  handle: vi.fn(),
  transportClose: vi.fn(),
  serverClose: vi.fn(),
  onRequest: vi.fn((_options: unknown, handler: unknown) => handler),
  onCall: vi.fn((_options: unknown, handler: unknown) => handler),
}));
vi.mock('firebase-functions/v2/https', () => ({ onRequest: mocks.onRequest, onCall: mocks.onCall, HttpsError: class extends Error {} }));
vi.mock('./admin', () => ({ db: {}, adminAuth: {} }));
vi.mock('./auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth')>()),
  authenticateMcpRequest: mocks.auth,
}));
vi.mock('./rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rate-limit')>()),
  allowMcpRequest: mocks.allow,
}));
vi.mock('./server', () => ({
  buildReceiptsMcpServer: () => ({ connect: mocks.connect, close: mocks.serverClose }),
}));
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class {
    handleRequest = mocks.handle;
    close = mocks.transportClose;
  },
}));
import { createMcpHandler } from './http';
import { buildReceiptsMcpServer } from './server';
import type { ToolRegistrar } from './server';
import { preAuthLimiter } from './pre-auth-limit';
const handlerFor = (registrars: readonly ToolRegistrar[] = [], limiter = preAuthLimiter) => createMcpHandler({ requiredScope: 'receipts:read', buildServer: (ctx) => buildReceiptsMcpServer(ctx, registrars), limiter });
import './index';
import { McpAuthError } from './auth';
import { hashMcpKey } from './keys-pure';
import { createPreAuthLimiter, PRE_AUTH_LIMIT_MESSAGE } from './pre-auth-limit';

const key = 'rcv_' + 'A'.repeat(43);
function request(body: unknown = {}, rawBody?: Buffer, authorization = `Bearer ${key}`) {
  return { method: 'POST', body, rawBody, get: () => authorization } as unknown as Request;
}
function response() {
  return Object.assign(new EventEmitter(), {
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  });
}
beforeEach(() => {
  mocks.auth
    .mockReset()
    .mockResolvedValue({ uid: 'u', email: 'owner@example.com', keyId: hashMcpKey(key) });
  mocks.allow.mockReset().mockReturnValue(true);
  mocks.connect.mockReset().mockResolvedValue(undefined);
  mocks.handle.mockReset().mockResolvedValue(undefined);
  mocks.transportClose.mockReset().mockResolvedValue(undefined);
  mocks.serverClose.mockReset().mockResolvedValue(undefined);
});

test('deployment options use a single public instance', () => {
  expect(mocks.onRequest).toHaveBeenCalledWith(
    expect.objectContaining({ maxInstances: 1 }),
    expect.any(Function)
  );
  expect(mocks.onRequest.mock.calls[0][0]).not.toHaveProperty('invoker');
});

test.each([request({}, Buffer.alloc(65_537)), request({ text: 'あ'.repeat(22_000) })])(
  'oversized raw or fallback body never authenticates',
  async (req) => {
    const res = response();
    await handlerFor([], createPreAuthLimiter())(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'リクエストが大きすぎます' },
      id: null,
    });
    expect(mocks.auth).not.toHaveBeenCalled();
  }
);

test('exactly 64 KiB raw body is admitted and batches are rejected before auth', async () => {
  const handler = handlerFor([], createPreAuthLimiter());
  await handler(request({}, Buffer.alloc(65_536)), response() as unknown as Response);
  expect(mocks.auth).toHaveBeenCalledTimes(1);
  mocks.auth.mockClear();
  const res = response();
  await handler(
    request([{ jsonrpc: '2.0', id: 1, method: 'initialize' }]),
    res as unknown as Response
  );
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({
    jsonrpc: '2.0',
    error: { code: -32600, message: 'まとめての呼び出しには対応していません' },
    id: null,
  });
  expect(mocks.auth).not.toHaveBeenCalled();
});

test('failure flood stops unknown keys before auth but rechecks known-good keys', async () => {
  const handler = handlerFor(
    [],
    createPreAuthLimiter(() => 0)
  );
  await handler(request(), response() as unknown as Response);
  mocks.auth.mockRejectedValue(new McpAuthError(401, '接続キーが無効です', 'unknown_key'));
  const unknown = 'Bearer rcv_' + 'B'.repeat(43);
  for (let i = 0; i < 31; i++)
    await handler(request({}, undefined, unknown), response() as unknown as Response);
  mocks.auth.mockClear();
  for (const header of [unknown, 'invalid']) {
    const res = response();
    await handler(request({}, undefined, header), res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      error: { code: -32002, message: PRE_AUTH_LIMIT_MESSAGE },
      id: null,
    });
  }
  expect(mocks.auth).not.toHaveBeenCalled();
  // A previously successful key must still be checked for revocation.
  const res = response();
  await handler(request(), res as unknown as Response);
  expect(mocks.auth).toHaveBeenCalledTimes(1);
  expect(res.status).toHaveBeenCalledWith(401);
});

test('total request cap short-circuits before authentication', async () => {
  const handler = handlerFor(
    [],
    createPreAuthLimiter(() => 0)
  );
  for (let i = 0; i < 120; i++) await handler(request(), response() as unknown as Response);
  const res = response();
  await handler(request(), res as unknown as Response);
  expect(mocks.auth).toHaveBeenCalledTimes(120);
  expect(res.status).toHaveBeenCalledWith(429);
});

test.each(['event-first', 'error-first', 'close-rejects'])(
  'closes only once: %s',
  async (order) => {
    const res = response();
    if (order === 'close-rejects')
      mocks.transportClose.mockRejectedValue(new Error('close failed'));
    mocks.handle.mockImplementation(async () => {
      if (order === 'event-first') res.emit('close');
      throw new Error('transport failed');
    });
    await handlerFor([], createPreAuthLimiter())(
      request(),
      res as unknown as Response
    );
    res.emit('close');
    res.emit('close');
    await Promise.resolve();
    expect(mocks.transportClose).toHaveBeenCalledTimes(1);
    expect(mocks.serverClose).toHaveBeenCalledTimes(1);
  }
);

test('single deployment: one function, writer account, read scope at the door', async () => {
  expect(mocks.onRequest).toHaveBeenCalledTimes(2);
  expect(mocks.onRequest.mock.calls[1][0]).toMatchObject({ maxInstances: 1, serviceAccount: 'receipts-mcp-writer@your-firebase-project-id.iam.gserviceaccount.com' });
  expect(mocks.onCall).toHaveBeenCalledTimes(1);
  expect(mocks.onCall.mock.calls[0][0]).toEqual({
    region: 'asia-northeast1', timeoutSeconds: 30, memory: '256MiB', maxInstances: 1,
    serviceAccount: 'receipts-mcp-writer@your-firebase-project-id.iam.gserviceaccount.com',
  });
  expect(mocks.onRequest.mock.calls[0][0]).toEqual({
    region: 'asia-northeast1', timeoutSeconds: 60, memory: '512MiB', maxInstances: 1,
    serviceAccount: 'receipts-mcp-writer@your-firebase-project-id.iam.gserviceaccount.com',
  });
});

test('401 tells OAuth clients where the protected resource metadata lives', async () => {
  const { McpAuthError } = await import('./auth');
  mocks.auth.mockReset().mockRejectedValue(new McpAuthError(401, '接続キーがありません', 'no_key'));
  const handler = createMcpHandler({ requiredScope: 'receipts:read', buildServer: () => ({}) as never, limiter: { allow: () => true, recordFailure: () => {}, recordSuccess: () => {} } as never });
  const res = response();
  await handler(request(), res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', expect.stringContaining('/.well-known/oauth-protected-resource/mcp'));
});
