import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolResult } from './tool-helpers';

export const MAX_STRUCTURED_BYTES = 200_000;
export const structuredBytes = (data: object) => Buffer.byteLength(JSON.stringify(data), 'utf8');

/** Never replace scalar metrics to fit the payload: fail if compaction is insufficient.
 * 応答は同じデータを文章と structuredContent の両方に入れるため、完成した応答全体で測る。 */
export function boundedResult(summary: string, data: object): CallToolResult {
  const result = toolResult(summary, data);
  if (structuredBytes(result) > MAX_STRUCTURED_BYTES) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: '結果が 200 KB の上限を超えています。期間・取引先などで絞って再度お試しください。',
        },
      ],
    };
  }
  return result;
}
