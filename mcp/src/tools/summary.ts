import { z } from 'zod';
import type { ToolRegistrar } from '../server';
import type { Snapshot } from '../data';
import { searchChains, summarize } from '../receipts-pure';
import { readOnly, runTool, inputError } from '../tool-helpers';
import { boundedResult } from '../result-size';
import { dateInput } from './inputs';

export const registerSummary = (get: () => Promise<Snapshot>): ToolRegistrar => (server, ctx) => {
  server.registerTool('get_monthly_summary', {
    title: '領収書の集計',
    description: '削除済みを除いた合計と、事業按分後の合計を返します。月別は新しい月から、科目・案件別は合計の大きい順。asOf は UTC です。',
    inputSchema: { by: z.enum(['month', 'category', 'project']).optional(), dateFrom: dateInput.optional(), dateTo: dateInput.optional() },
    annotations: readOnly,
  }, async (args) => runTool('get_monthly_summary', ctx, async () => {
    if (args.dateFrom && args.dateTo && args.dateFrom > args.dateTo) return inputError('開始日は終了日以前にしてください。');
    const snap = await get();
    const by = args.by ?? 'month';
    return boundedResult('領収書の集計', { asOf: snap.asOf, by, buckets: summarize(searchChains(snap.chains, args), by), skipped: snap.skipped });
  }));
};
