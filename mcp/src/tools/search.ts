import { z } from 'zod';
import type { ToolRegistrar } from '../server';
import type { Snapshot } from '../data';
import { isRegisteredLate, searchChains, type Chain } from '../receipts-pure';
import { readOnly, runTool, inputError } from '../tool-helpers';
import { boundedResult } from '../result-size';
import { amountInput, dateInput, kindInput, limitInput, statusInput } from './inputs';

export const toRow = (chain: Chain) => {
  const r = chain.latest;
  return {
  chainId: r.chainId, receiptDate: r.receiptDate, amount: r.amount, vendor: r.vendor, kind: r.kind,
  category: r.category, businessRatio: r.businessRatio, project: r.project, memo: r.memo,
  status: r.status, journalNo: r.journalNo, deleted: r.deleted, version: r.version,
  registeredAt: r.registeredAt, registeredLate: isRegisteredLate(chain),
  };
};

export const registerSearch = (get: () => Promise<Snapshot>): ToolRegistrar => (server, ctx) => {
  server.registerTool(
    'search_receipts',
    {
      title: '領収書の検索',
      description: '領収書を日付・金額・取引先などで検索します。最新版（訂正反映後）で検索し、削除済みは既定で除外します。取引先は全角半角・大文字小文字を区別しない部分一致です。取引日の新しい順、最大 200 件。asOf は UTC です。',
      inputSchema: {
        dateFrom: dateInput.optional(), dateTo: dateInput.optional(),
        amountMin: amountInput.optional(), amountMax: amountInput.optional(),
        vendor: z.string().max(100).optional(), kind: kindInput.optional(), status: statusInput.optional(),
        category: z.string().max(100).optional(), includeDeleted: z.boolean().optional(), limit: limitInput.optional(),
      },
      annotations: readOnly,
    },
    async (args) =>
      runTool('search_receipts', ctx, async () => {
        if (args.dateFrom && args.dateTo && args.dateFrom > args.dateTo) return inputError('開始日は終了日以前にしてください。');
        const snap = await get();
        const hits = searchChains(snap.chains, args).sort((a, b) => b.latest.receiptDate.localeCompare(a.latest.receiptDate));
        const limit = args.limit ?? 50;
        const rows = hits.slice(0, limit).map(toRow);
        return boundedResult(`${hits.length} 件中 ${rows.length} 件`, {
          asOf: snap.asOf, total: hits.length, truncated: hits.length > rows.length, skipped: snap.skipped, rows,
        });
      })
  );
};
