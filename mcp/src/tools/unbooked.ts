import { z } from 'zod';
import type { ToolRegistrar } from '../server';
import type { Snapshot } from '../data';
import { searchChains } from '../receipts-pure';
import { readOnly, runTool } from '../tool-helpers';
import { boundedResult } from '../result-size';
import { limitInput } from './inputs';
import { toRow } from './search';

export const registerUnbooked = (get: () => Promise<Snapshot>): ToolRegistrar => (server, ctx) => {
  server.registerTool('list_unbooked', {
    title: '未記帳の領収書',
    description: '未記帳または要確認の領収書を取引日の古い順に返します。削除済みは除外、最大 200 件。asOf は UTC です。',
    inputSchema: { status: z.enum(['未記帳', '要確認']).optional(), limit: limitInput.optional() },
    annotations: readOnly,
  }, async (args) => runTool('list_unbooked', ctx, async () => {
    const snap = await get();
    const hits = searchChains(snap.chains, { status: args.status ?? '未記帳' }).sort((a, b) => a.latest.receiptDate.localeCompare(b.latest.receiptDate));
    const rows = hits.slice(0, args.limit ?? 50).map(toRow);
    return boundedResult(`${hits.length} 件中 ${rows.length} 件`, { asOf: snap.asOf, total: hits.length, truncated: hits.length > rows.length, skipped: snap.skipped, rows });
  }));
};
