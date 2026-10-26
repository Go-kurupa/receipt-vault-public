import { createHash } from "crypto";
import { HttpsError } from "firebase-functions/v2/https";
import { FieldValue, type Firestore, type Transaction } from "firebase-admin/firestore";

export interface RequestIdentity {
  fn: string;
  payloadHash: string;
  requestId?: string;
  ownerEmail?: string;
}

export interface RequestLog<Result> {
  fn: string;
  payloadHash: string;
  ownerEmail?: string;
  result: Result;
}

export interface LoggedResult {
  ok: boolean;
  chainId: string;
  docId: string;
  version: number;
  status?: string;
}

// 訂正項目は要求ログに残さない。再送の応答は検証済みの要求から組み立てる。
export function minimalRequestResult(result: LoggedResult, fn: string): LoggedResult {
  const { ok, chainId, docId, version } = result;
  return { ok, chainId, docId, version, ...(fn === "updateReceiptStatus" ? { status: result.status } : {}) };
}

export function validateRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 8 || value.length > 100 || /[^A-Za-z0-9-]/.test(value)) {
    throw new HttpsError("invalid-argument", "requestId は英数字とハイフンで8〜100文字にしてください");
  }
  return value;
}

// オブジェクトのキー順に依存せず、配列の順序・日本語・空値は保持する。
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return item;
  });
}

export function hashPayload(data: Record<string, unknown>, fileBytes?: Buffer): string {
  const { requestId: _requestId, fileBase64: _fileBase64, ...payload } = data;
  // 大きな base64 文字列の代わりに、変換していない原本バイト列のハッシュを使う。
  const canonical = fileBytes === undefined ? payload : {
    payload,
    fileSha256: createHash("sha256").update(fileBytes).digest("hex"),
  };
  return createHash("sha256").update(canonicalJson(canonical)).digest("hex");
}

export function decideRequestLog<Result>(
  existing: RequestLog<Result> | undefined,
  identity: Pick<RequestIdentity, "fn" | "payloadHash">,
): { kind: "create" } | { kind: "replay"; result: Result } {
  if (!existing) return { kind: "create" };
  if (existing.fn !== identity.fn || existing.payloadHash !== identity.payloadHash) {
    throw new HttpsError("already-exists", "この要求IDは別の処理または入力内容で使用済みです。新しい要求IDで送信してください");
  }
  return { kind: "replay", result: existing.result };
}

// 要求ログと証憑を同時に新規作成する。既存の証憑・要求ログは変更しない。
export async function runLoggedTransaction<Result extends LoggedResult>(
  db: Firestore,
  identity: RequestIdentity,
  create: (tx: Transaction) => Promise<Result>,
): Promise<{ result: Result; replayed: boolean }> {
  const logRef = identity.requestId === undefined ? undefined : db.collection("requestLog").doc(identity.requestId);
  return db.runTransaction(async (tx) => {
    if (logRef) {
      const snapshot = await tx.get(logRef);
      const decision = decideRequestLog(snapshot.data() as RequestLog<Result> | undefined, identity);
      if (decision.kind === "replay") return { result: decision.result, replayed: true };
    }

    const result = await create(tx);
    if (logRef) {
      tx.create(logRef, {
        fn: identity.fn,
        payloadHash: identity.payloadHash,
        ...(identity.ownerEmail === undefined ? {} : { ownerEmail: identity.ownerEmail }),
        result: minimalRequestResult(result, identity.fn),
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    return { result, replayed: false };
  });
}
