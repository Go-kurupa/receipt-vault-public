import { createHash, randomBytes } from 'node:crypto';
export const MCP_KEY_PREFIX = 'rcv_';
export const MCP_KEY_BODY_LENGTH = 43;
export function generateMcpKey(): string {
  return MCP_KEY_PREFIX + randomBytes(32).toString('base64url');
}
export function hashMcpKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const cleaned = header
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .replace(/^bearer(?=[\s:：]|rc[va]_)[\s:：]*/i, '')
    .replace(/[\s"'「」『』]/g, '');
  // rcv_ = 接続キー、rca_ = ログイン連携（OAuth）のアクセストークン。
  return /^rc[va]_[A-Za-z0-9_-]{43}$/.test(cleaned) ? cleaned : null;
}
export function describeAuthorizationHeader(header: string | undefined) {
  return {
    present: header !== undefined,
    length: header?.length ?? 0,
    hasBearerPrefix: /^bearer/i.test(header?.trim() ?? ''),
    hasNonAscii: Array.from(header ?? '').some((char) => char.charCodeAt(0) > 127),
    hasNewline: /[\r\n]/.test(header ?? ''),
  };
}
