import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";

// mcp/src/admin-api/manage.ts の応答と同じ形。鍵そのものは発行の応答にだけ含まれる。
export interface AiConnection {
  keyId: string;
  label: string;
  scopes: string[];
  createdAt: string | null;
  createdBy: string | null;
  revoked: boolean;
}
export interface AiGrant {
  grantId: string;
  clientName: string;
  vendor: string;
  scopes: string[];
  createdAt: string | null;
  revoked: boolean;
}
export interface AiConnectionList {
  writeEnabled: boolean;
  keys: AiConnection[];
  grants: AiGrant[];
  /** 新しいログイン連携を受け付ける期限（ミリ秒）。0 は閉じている。 */
  acceptUntil: number;
}
export interface OauthRequestInfo {
  clientName: string;
  vendor: string;
  redirectHost: string;
  requestedScopes: string[];
  expiresAt: number;
  acceptOpen: boolean;
}
export interface IssuedKey {
  key: string;
  keyIdPrefix: string;
  label: string;
  scopes: string[];
}

type ManageRequest =
  | { action: "list" }
  | { action: "issue"; label: string; organize: boolean }
  | { action: "setOrganize"; keyId: string; organize: boolean }
  | { action: "revoke"; keyId: string }
  | { action: "setWrite"; enabled: boolean }
  | { action: "openAccept" }
  | { action: "closeAccept" }
  | { action: "getOauthRequest"; requestId: string }
  | { action: "decideOauth"; requestId: string; approve: boolean; organize: boolean }
  | { action: "revokeGrant"; grantId: string };

async function manage<T>(req: ManageRequest): Promise<T> {
  const fn = httpsCallable<ManageRequest, T>(functions, "manageAiConnections");
  return (await fn(req)).data;
}

export const listAiConnections = () => manage<AiConnectionList>({ action: "list" });
export const issueAiKey = (label: string, organize: boolean) => manage<IssuedKey>({ action: "issue", label, organize });
export const setAiOrganize = (keyId: string, organize: boolean) => manage<unknown>({ action: "setOrganize", keyId, organize });
export const revokeAiKey = (keyId: string) => manage<unknown>({ action: "revoke", keyId });
export const setAiWrite = (enabled: boolean) => manage<unknown>({ action: "setWrite", enabled });
export const openAiAccept = () => manage<{ acceptUntil: number }>({ action: "openAccept" });
export const closeAiAccept = () => manage<{ acceptUntil: number }>({ action: "closeAccept" });
export const getOauthRequest = (requestId: string) => manage<OauthRequestInfo>({ action: "getOauthRequest", requestId });
export const decideOauth = (requestId: string, approve: boolean, organize: boolean) =>
  manage<{ redirectUrl: string }>({ action: "decideOauth", requestId, approve, organize });
export const revokeAiGrant = (grantId: string) => manage<unknown>({ action: "revokeGrant", grantId });

/** 受付の残り時間（分・切り上げ）。閉じていれば 0。 */
export function acceptMinutesLeft(acceptUntil: number, now: number): number {
  return acceptUntil > now ? Math.ceil((acceptUntil - now) / 60_000) : 0;
}

/** 許可画面の要求 ID（/connect?request=）。Firestore の docId に使える形だけ受け付ける。 */
export function readRequestParam(search: string): string | null {
  const v = new URLSearchParams(search).get("request");
  return v && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null;
}

export const canOrganize = (c: Pick<AiConnection, "scopes">) => c.scopes.includes("receipts:organize");

export function describeScopes(scopes: string[]): string {
  if (scopes.includes("receipts:organize")) return "読む＋整理";
  if (scopes.includes("receipts:read")) return "読む";
  return "なし";
}

export function describeOrigin(createdBy: string | null): string {
  if (createdBy === "web") return "この画面";
  if (createdBy === "issue-key-script") return "コマンド";
  return "不明";
}

/** 日付だけを日本時間で表示する（端末の時刻設定に依存しない）。 */
export function formatJstDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** Functions の HttpsError の文言は日本語で返しているので、それを優先して表示する。 */
export function errorMessage(error: unknown): string {
  const e = error as { code?: string; message?: string } | null;
  if (e?.code === "functions/permission-denied") return "このアカウントには権限がありません";
  if (e?.code === "functions/unavailable" || e?.code === "functions/deadline-exceeded") return "通信できませんでした。電波状況を確認して、もう一度お試しください";
  if (e?.message && /[ぁ-んァ-ン一-龥]/.test(e.message)) return e.message;
  return "処理に失敗しました。時間をおいて再度お試しください";
}
