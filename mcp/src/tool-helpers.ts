import { logger } from 'firebase-functions';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpRequestContext } from './server';
export const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
export function toolResult(summaryText: string, data: object): CallToolResult {
  return {
    content: [{ type: 'text', text: summaryText + '\n' + JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}
export async function runTool(
  name: string,
  ctx: McpRequestContext,
  fn: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  const start = Date.now();
  let ok = false;
  let rows: number | undefined;
  try {
    const result = await fn();
    ok = result.isError !== true;
    const count = result.structuredContent?.rows;
    if (typeof count === 'number' && Number.isFinite(count)) rows = count;
    else if (Array.isArray(count)) rows = count.length;
    return result;
  } catch {
    return {
      isError: true,
      content: [
        { type: 'text', text: 'データの取得に失敗しました。時間をおいて再度お試しください。' },
      ],
    };
  } finally {
    logger.info('mcp: tool', {
      tool: name,
      keyIdPrefix: ctx.keyId.slice(0, 8),
      durationMs: Date.now() - start,
      ok,
      ...(rows !== undefined ? { rows } : {}),
    });
  }
}

export function inputError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
