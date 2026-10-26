import { z } from 'zod';
import { logger } from 'firebase-functions';
import type { Firestore } from 'firebase-admin/firestore';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolRegistrar, McpRequestContext } from '../server';
import { db } from '../admin';
import { boundedResult } from '../result-size';
import { inputError, readOnly } from '../tool-helpers';
import { APP_URL } from '../tools/inputs';
import { parseOrganizePatch } from './organize-pure';
import { applyDraft, createDraft, DRAFT_TTL_MS, OrganizeError } from './organize-store';
import { isReceiptsWriteEnabled } from './kill-switch';
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
interface WriteDependencies { db: Firestore; now?: () => number }
async function execute(event: 'receipts_organize_preview' | 'receipts_organize_apply', ctx: McpRequestContext, fn: (audit: { chainId?: string; fields: string[]; result: string }) => Promise<CallToolResult>): Promise<CallToolResult> {
  const audit: { chainId?: string; fields: string[]; result: string } = { fields: [], result: 'error' };
  try { return await fn(audit); }
  catch (error) {
    audit.result = error instanceof OrganizeError ? error.code : 'error';
    return inputError(error instanceof OrganizeError ? error.message : '処理に失敗しました。時間をおいて再度お試しください。');
  } finally {
    logger.info(event, { keyId: ctx.keyId.slice(0, 8), ...audit });
  }
}
export function organizeRegistrars(deps: WriteDependencies): readonly ToolRegistrar[] {
  const now = deps.now ?? Date.now;
  const preview: ToolRegistrar = (server, ctx) => {
    server.registerTool('preview_update_receipt', {
      title: '領収書の変更下書き',
      description: '科目・メモ・案件・按分・状態・仕訳番号の変更下書きを作成します。有効期限は10分です。表示後に必ず利用者の明示的な了承を得てから apply_update_receipt を呼んでください。',
      inputSchema: { chainId: identifier, patch: z.object({
        category: z.string().nullable().optional(), memo: z.string().nullable().optional(), project: z.string().nullable().optional(),
        businessRatio: z.number().optional(), status: z.string().describe('未記帳 / 記帳済 / 要確認 のいずれか').optional(), journalNo: z.string().nullable().optional(),
      }).strict() }, annotations: readOnly,
    }, async ({ chainId, patch }) => execute('receipts_organize_preview', ctx, async audit => {
      audit.chainId = chainId;
      const parsed = parseOrganizePatch(patch);
      if (!parsed.ok) { audit.result = 'invalid_patch'; return inputError(parsed.error); }
      const at = now();
      const { draftId, latest, changes } = await createDraft(deps.db, { keyId: ctx.keyId, chainId, patch: parsed.patch, now: at });
      audit.fields = changes.map(c => c.field);
      const writeEnabled = await isReceiptsWriteEnabled(deps.db);
      const result = boundedResult('領収書の変更下書き。内容を確認し、利用者の了承を得てください。', {
        status: 'ready', draftId, chainId, vendor: latest.vendor, receiptDate: latest.receiptDate, amount: latest.amount, changes,
        writeEnabled, warnings: writeEnabled ? [] : ['書き込みは停止中です'], expiresAt: at + DRAFT_TTL_MS, appUrl: APP_URL + '?chain=' + encodeURIComponent(chainId),
      });
      audit.result = result.isError ? 'too_large' : 'ready';
      return result;
    }));
  };
  const apply: ToolRegistrar = (server, ctx) => {
    server.registerTool('apply_update_receipt', {
      title: '領収書の変更確定', description: '表示した下書きについて利用者の明確な了承を得た場合だけ呼んでください。新しい版を追加します。同じ下書きの再送は同じ結果を返します。',
      inputSchema: { draftId: identifier }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ draftId }) => execute('receipts_organize_apply', ctx, async audit => {
      if (!await isReceiptsWriteEnabled(deps.db)) { audit.result = 'disabled'; return inputError('書き込みは停止中です'); }
      const result = await applyDraft(deps.db, { keyId: ctx.keyId, keyLabel: ctx.keyLabel, draftId, now: now() }, fields => { audit.fields = fields; });
      audit.chainId = result.chainId;
      audit.result = result.replayed ? 'replayed' : 'applied';
      return boundedResult('領収書の変更を確定しました', { ok: true, chainId: result.chainId, version: result.version, replayed: result.replayed, note: '読み取り窓口への反映は最大 1 分遅れます' });
    }));
  };
  return [preview, apply];
}
export const ORGANIZE_REGISTRARS = organizeRegistrars({ db });
