import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue, type Transaction } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { logger } from "firebase-functions";
import { createHash, randomBytes } from "crypto";
import { parseReceiptInput, type ReceiptInputRaw } from "./schema";
import { buildReceiptDoc, buildCorrectionDoc, SERVER_TIMESTAMP, type ReceiptDoc, type ReceiptStatus } from "./versioning";
import { validateRequestId, hashPayload, decideRequestLog, runLoggedTransaction, type RequestLog } from "./idempotency";

// 所有者本人のみ。Firestore/Storage Rules の email 直指定と同じ値を使う。
const OWNER_EMAIL = "owner@example.com";
const COLLECTION = "receipts";
const ALLOWED_STATUS: ReceiptStatus[] = ["未記帳", "記帳済", "要確認"];
const CORRECTABLE_FIELDS = new Set(["receiptDate", "amount", "vendor", "category", "businessRatio", "project", "memo"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 電子取引データは born-digital のため紙スキャンの画素数基準を適用しない (resolutionOk は常に true)。
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB (Cloud Storage 直アップロードでなく base64 経由のため小さめに抑える)
const ALLOWED_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

initializeApp({ credential: applicationDefault() });

function requireOwner(auth: { token: { email?: string; email_verified?: boolean } } | undefined): void {
  if (!auth || !auth.token.email_verified || auth.token.email !== OWNER_EMAIL) {
    throw new HttpsError("permission-denied", "このアカウントには権限がありません");
  }
}

function resolveTimestamps(doc: ReceiptDoc): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...doc };
  for (const key of ["registeredAt", "deletedAt"] as const) {
    if (resolved[key] === SERVER_TIMESTAMP) resolved[key] = FieldValue.serverTimestamp();
  }
  return resolved;
}

async function getLatestVersion(tx: Transaction, chainId: string): Promise<(ReceiptDoc & { docId: string }) | null> {
  const db = getFirestore();
  const query = db
    .collection(COLLECTION)
    .where("chainId", "==", chainId)
    .orderBy("version", "desc")
    .limit(1);
  const snap = await tx.get(query);
  if (snap.empty) return null;
  const docSnap = snap.docs[0]!;
  return { ...(docSnap.data() as ReceiptDoc), docId: docSnap.id };
}

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function readCorrectionPatch(input: unknown): Pick<
  Partial<ReceiptDoc>,
  "receiptDate" | "amount" | "vendor" | "category" | "businessRatio" | "project" | "memo"
> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpsError("invalid-argument", "patch はオブジェクトである必要があります");
  }

  const raw = input as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length === 0) {
    throw new HttpsError("invalid-argument", "patch に訂正対象の項目がありません");
  }
  for (const key of keys) {
    if (!CORRECTABLE_FIELDS.has(key)) {
      throw new HttpsError("invalid-argument", `patch.${key} は訂正対象外です`);
    }
  }

  const patch: Pick<
    Partial<ReceiptDoc>,
    "receiptDate" | "amount" | "vendor" | "category" | "businessRatio" | "project" | "memo"
  > = {};

  if (hasOwn(raw, "receiptDate")) {
    const receiptDate = raw.receiptDate;
    if (typeof receiptDate !== "string" || !isValidDate(receiptDate)) {
      throw new HttpsError("invalid-argument", `receiptDate は YYYY-MM-DD 形式である必要があります: ${String(receiptDate)}`);
    }
    patch.receiptDate = receiptDate;
  }

  if (hasOwn(raw, "amount")) {
    const amount = raw.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      throw new HttpsError("invalid-argument", `amount は正の数である必要があります: ${String(amount)}`);
    }
    patch.amount = amount;
  }

  if (hasOwn(raw, "vendor")) {
    const vendor = raw.vendor;
    if (typeof vendor !== "string" || vendor.trim().length === 0) {
      throw new HttpsError("invalid-argument", "vendor は空にできません");
    }
    patch.vendor = vendor;
  }

  if (hasOwn(raw, "businessRatio")) {
    const businessRatio = raw.businessRatio;
    if (typeof businessRatio !== "number" || !Number.isFinite(businessRatio) || businessRatio < 0 || businessRatio > 100) {
      throw new HttpsError("invalid-argument", `businessRatio は 0〜100 である必要があります: ${String(businessRatio)}`);
    }
    patch.businessRatio = businessRatio;
  }

  for (const key of ["category", "project", "memo"] as const) {
    if (hasOwn(raw, key)) {
      const value = raw[key];
      if (typeof value !== "string") {
        throw new HttpsError("invalid-argument", `${key} は文字列である必要があります`);
      }
      patch[key] = value;
    }
  }

  return patch;
}

/**
 * Web ビューアーから「未記帳→記帳済」等の状態変更を行う唯一の書込み経路。
 * クライアントは Firestore へ直接書込めない (Rules で全拒否) ため、この Function 経由でのみ状態変更できる。
 * CLI の correct と同じ「新バージョン追加」方式 (追記専用) を維持する。
 */
export const updateReceiptStatus = onCall<{ chainId: string; status: string; requestId?: string }>(
  { region: "asia-northeast1" },
  async (request) => {
    requireOwner(request.auth);
    const { chainId, status } = request.data;
    const requestId = validateRequestId(request.data.requestId);
    if (!chainId || typeof chainId !== "string") {
      throw new HttpsError("invalid-argument", "chainId が必要です");
    }
    if (!ALLOWED_STATUS.includes(status as ReceiptStatus)) {
      throw new HttpsError("invalid-argument", `status は ${ALLOWED_STATUS.join("/")} のいずれかである必要があります`);
    }

    const db = getFirestore();
    const { result } = await runLoggedTransaction(db, {
      fn: "updateReceiptStatus", requestId, payloadHash: hashPayload(request.data), ownerEmail: OWNER_EMAIL,
    }, async (tx) => {
      const latest = await getLatestVersion(tx, chainId);
      if (!latest) throw new HttpsError("not-found", "対象の証憑が見つかりません");
      if (latest.deleted) throw new HttpsError("failed-precondition", "削除済みの証憑は状態変更できません");

      const newDoc = buildCorrectionDoc(latest, { status: status as ReceiptStatus });
      const newRef = db.collection(COLLECTION).doc();
      tx.create(newRef, resolveTimestamps(newDoc));
      return { ok: true, chainId, docId: newRef.id, version: newDoc.version, status: newDoc.status };
    });
    return result;
  },
);

/**
 * Web ビューアーから登録済み証憑の法定検索項目・メモを訂正する経路。
 * 既存ドキュメントは変更せず、状態変更と同じ「新バージョン追加」方式 (追記専用) を維持する。
 */
export const correctReceipt = onCall<Record<string, unknown>>(
  { region: "asia-northeast1" },
  async (request) => {
    requireOwner(request.auth);
    const d = request.data;
    const requestId = validateRequestId(d?.requestId);
    const chainId = d?.chainId;
    if (!chainId || typeof chainId !== "string") {
      throw new HttpsError("invalid-argument", "chainId が必要です");
    }

    const patch = readCorrectionPatch(d.patch);
    const db = getFirestore();
    const { result } = await runLoggedTransaction(db, {
      fn: "correctReceipt", requestId, payloadHash: hashPayload(d), ownerEmail: OWNER_EMAIL,
    }, async (tx) => {
      const latest = await getLatestVersion(tx, chainId);
      if (!latest) throw new HttpsError("not-found", "対象の証憑が見つかりません");
      if (latest.deleted) throw new HttpsError("failed-precondition", "削除済みの証憑は訂正できません");

      const newDoc = buildCorrectionDoc(latest, patch);
      const newRef = db.collection(COLLECTION).doc();
      tx.create(newRef, resolveTimestamps(newDoc));
      return { ok: true, chainId, docId: newRef.id, version: newDoc.version };
    });
    return { ok: result.ok, chainId: result.chainId, docId: result.docId, version: result.version, patch };
  },
);

interface UploadDigitalReceiptRequest {
  requestId?: string;
  fileBase64: string;
  mimeType: string;
  receiptDate: string;
  amount: number;
  vendor: string;
  category?: string;
  businessRatio?: number;
  project?: string;
  memo?: string;
}

/**
 * Web ビューアーからの電子取引データ (Amazon 領収書等の PDF/画像) 登録。
 * 紙レシートの Discord 経路と異なり OCR は行わず、フォーム入力値をそのまま登録する。
 */
export const uploadDigitalReceipt = onCall<UploadDigitalReceiptRequest>(
  { region: "asia-northeast1", memory: "256MiB" },
  async (request) => {
    requireOwner(request.auth);
    const d = request.data;
    const requestId = validateRequestId(d.requestId);

    const ext = ALLOWED_MIME[d.mimeType];
    if (!ext) {
      throw new HttpsError("invalid-argument", `対応していないファイル形式です: ${d.mimeType}`);
    }

    let buf: Buffer;
    try {
      buf = Buffer.from(d.fileBase64, "base64");
    } catch {
      throw new HttpsError("invalid-argument", "ファイルデータのデコードに失敗しました");
    }
    if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
      throw new HttpsError("invalid-argument", `ファイルサイズが不正です (${buf.length} bytes)`);
    }

    const raw: ReceiptInputRaw = {
      kind: "digital",
      receiptDate: d.receiptDate,
      amount: d.amount,
      vendor: d.vendor,
      receivedDate: d.receiptDate, // 電子取引データは授受日=取引年月日として扱う (紙の受領日入力期限は非適用)
      source: "web",
      category: d.category,
      businessRatio: d.businessRatio,
      project: d.project,
      memo: d.memo,
    };
    const parsed = parseReceiptInput(raw);
    if (!parsed.ok) {
      throw new HttpsError("invalid-argument", parsed.error);
    }

    const db = getFirestore();
    const identity = {
      fn: "uploadDigitalReceipt", requestId,
      payloadHash: hashPayload({ ...d }, buf), ownerEmail: OWNER_EMAIL,
    };
    if (requestId !== undefined) {
      const snapshot = await db.collection("requestLog").doc(requestId).get();
      const decision = decideRequestLog(snapshot.data() as RequestLog<{
        ok: boolean; chainId: string; docId: string; version: number;
      }> | undefined, identity);
      if (decision.kind === "replay") return decision.result;
    }

    const chainId = randomBytes(6).toString("base64url").slice(0, 8);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const year = parsed.value.receiptDate.slice(0, 4);
    // 同じ要求の再試行は同じ原本を使う。異なる入力の同時送信でも原本を取り違えない。
    const storagePath = requestId === undefined ? `receipts/${year}/${chainId}/v1.${ext}` :
      `receipts/${year}/requests/${requestId}/${identity.payloadHash}/v1.${ext}`;

    try {
      await getStorage().bucket().file(storagePath).save(buf, {
        contentType: d.mimeType,
        metadata: { metadata: { sha256 } },
        preconditionOpts: { ifGenerationMatch: 0 }, // 原本は新規作成のみ。既存オブジェクトの上書きは禁止。
      });
    } catch (error) {
      if (requestId === undefined || (error as { code?: number }).code !== 412) throw error;
      // 同じ要求・内容の原本が既にある場合だけ再利用する。
    }

    const doc = buildReceiptDoc(parsed.value, {
      chainId,
      storagePath,
      sha256,
      mimeType: d.mimeType,
      resolutionOk: true,
    });
    try {
      const { result } = await runLoggedTransaction(db, identity, async (tx) => {
        tx.create(db.collection(COLLECTION).doc(chainId), resolveTimestamps(doc));
        return { ok: true, chainId, docId: chainId, version: 1 };
      });
      return result;
    } catch (error) {
      logger.warn("原本保存後に証憑の確定に失敗しました。未参照の原本が残る可能性があります", { requestId, storagePath });
      throw error;
    }
  },
);
