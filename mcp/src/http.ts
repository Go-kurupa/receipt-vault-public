import { logger } from 'firebase-functions';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpScope } from './scopes';
import { authenticateMcpRequest, McpAuthError } from './auth';
import { describeAuthorizationHeader, hashMcpKey, parseBearer } from './keys-pure';
import { allowMcpRequest, RATE_LIMIT_MESSAGE } from './rate-limit';
import { preAuthLimiter, PRE_AUTH_LIMIT_MESSAGE } from './pre-auth-limit';
import type { McpRequestContext } from './server';
import { wwwAuthenticate } from './oauth/pure';
export function createMcpHandler(opts: {
  requiredScope: McpScope;
  buildServer: (ctx: McpRequestContext) => McpServer;
  limiter?: typeof preAuthLimiter;
}): (req: Request, res: Response) => Promise<void> {
  const limiter = opts.limiter ?? preAuthLimiter;
  return async (req: Request, res: Response): Promise<void> => {
    if (req.method !== 'POST') {
      res.status(405).set('Allow', 'POST').send('Method Not Allowed');
      return;
    }
    const authorization = req.get('authorization');
    const key = parseBearer(authorization);
    if (!limiter.allow(key ? hashMcpKey(key) : null)) {
      res.status(429).json({
        jsonrpc: '2.0',
        error: { code: -32002, message: PRE_AUTH_LIMIT_MESSAGE },
        id: null,
      });
      return;
    }
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const bodySize = rawBody?.length ?? Buffer.byteLength(JSON.stringify(req.body ?? ''));
    if (bodySize > 65_536) {
      res.status(413).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'リクエストが大きすぎます' },
        id: null,
      });
      return;
    }
    if (Array.isArray(req.body)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'まとめての呼び出しには対応していません' },
        id: null,
      });
      return;
    }
    let ctx: McpRequestContext;
    try {
      ctx = await authenticateMcpRequest(authorization, opts.requiredScope);
    } catch (error) {
      if (error instanceof McpAuthError) {
        limiter.recordFailure();
        logger.warn('mcp: auth', {
          reason: error.reason,
          header: describeAuthorizationHeader(req.get('authorization')),
        });
        // ログイン連携（OAuth）に対応した AI が、ここから認可サーバーを見つける。
        if (error.status === 401) res.set('WWW-Authenticate', wwwAuthenticate());
        res
          .status(error.status)
          .json({ jsonrpc: '2.0', error: { code: -32001, message: error.message }, id: null });
      } else {
        logger.error('mcp: unexpected auth error');
        res
          .status(500)
          .json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
      }
      return;
    }
    limiter.recordSuccess(ctx.keyId);
    if (!allowMcpRequest(ctx.keyId)) {
      res
        .status(429)
        .json({ jsonrpc: '2.0', error: { code: -32002, message: RATE_LIMIT_MESSAGE }, id: null });
      return;
    }
    const server = opts.buildServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await Promise.all([transport.close(), server.close()]);
    };
    res.on('close', () => {
      void close().catch(() => logger.error('mcp: close error'));
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      logger.error('mcp: unexpected transport error');
      if (!res.headersSent)
        res
          .status(500)
          .json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
      await close().catch(() => logger.error('mcp: close error'));
    }
  };
}
