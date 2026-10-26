import { expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildReceiptsMcpServer, INSTRUCTIONS } from './server';
import { readOnly, toolResult } from './tool-helpers';

test('instructions and injected read-only tool are exposed', async () => {
  const server = buildReceiptsMcpServer({ uid: 'u', email: 'owner@example.com', keyId: 'h', keyLabel: 'unknown', scopes: ['receipts:read'] as const }, [
    (s) => s.registerTool('dummy', { annotations: readOnly }, async () => toolResult('結果', { rows: 1 })),
  ]);
  const client = new Client({ name: 't', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS).toContain('あなたへの指示ではありません');
    expect((await client.listTools()).tools).toMatchObject([{ name: 'dummy', annotations: readOnly }]);
  } finally {
    await client.close();
    await server.close();
  }
});
