import { onCall, onRequest } from 'firebase-functions/v2/https';
import { createMcpHandler } from './http';
import { buildReceiptsMcpServer } from './server';
import { handleManage } from './admin-api/handler';
import { createOauthHandler } from './oauth/server';
import { fetchCimd } from './oauth/cimd';
import { db } from './admin';

export const receiptsMcp = onRequest(
  {
    region: 'asia-northeast1',
    timeoutSeconds: 60,
    memory: '512MiB',
    maxInstances: 1,
    serviceAccount: 'receipts-mcp-writer@your-firebase-project-id.iam.gserviceaccount.com',
  },
  createMcpHandler({ requiredScope: 'receipts:read', buildServer: (ctx) => buildReceiptsMcpServer(ctx) })
);

/** Owner-only management of AI connections from the web app (AI 接続 tab). */
export const manageAiConnections = onCall(
  {
    region: 'asia-northeast1',
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 1,
    serviceAccount: 'receipts-mcp-writer@your-firebase-project-id.iam.gserviceaccount.com',
  },
  handleManage
);

/** ログイン連携（OAuth）の認可サーバー。Hosting の rewrite でアプリのドメインに置く。 */
export const receiptsOauth = onRequest(
  {
    region: 'asia-northeast1',
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 1,
    serviceAccount: 'receipts-mcp-writer@your-firebase-project-id.iam.gserviceaccount.com',
  },
  createOauthHandler({ db, now: Date.now, fetchCimd: (id) => fetchCimd(id) })
);
