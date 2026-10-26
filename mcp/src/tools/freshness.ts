import type { ToolRegistrar } from '../server';
import type { Snapshot } from '../data';
import { readOnly, runTool } from '../tool-helpers';
import { boundedResult } from '../result-size';

export const registerFreshness = (get: () => Promise<Snapshot>): ToolRegistrar => (server, ctx) => {
  server.registerTool('get_data_freshness', {
    title: 'データの鮮度',
    description: '領収書数（削除済みを含む）、版数、読み飛ばした行数と最終登録時刻を返します。最大 60 秒キャッシュします。asOf は UTC です。',
    inputSchema: {}, annotations: readOnly,
  }, async () => runTool('get_data_freshness', ctx, async () => {
    const snap = await get();
    return boundedResult('データの鮮度', { asOf: snap.asOf, receiptCount: snap.chains.length, versionCount: snap.chains.reduce((n, c) => n + c.versions.length, 0), skipped: snap.skipped, latestRegisteredAt: snap.latestRegisteredAt });
  }));
};
