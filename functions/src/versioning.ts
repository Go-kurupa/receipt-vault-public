// receipt-vault CLI (MiniPC /opt/claude-discord/receipt-vault/src/versioning.ts) と同一ロジック。
// 追記専用設計の正本は CLI 側にあり、この Functions はその設計を破らないよう同じ形を再利用する。
import type { ReceiptInput } from "./schema";

export const SERVER_TIMESTAMP = "__SERVER_TIMESTAMP__" as const;

export type ReceiptStatus = "未記帳" | "記帳済" | "要確認";

export interface ReceiptDoc {
  kind: ReceiptInput["kind"];
  receiptDate: string;
  amount: number;
  vendor: string;
  category: string | null;
  businessRatio: number;
  project: string | null;
  memo: string | null;
  receivedDate: string;
  registeredAt: typeof SERVER_TIMESTAMP;
  storagePath: string;
  sha256: string;
  mimeType: string;
  resolutionOk: boolean;
  chainId: string;
  version: number;
  prevVersionId: string | null;
  deleted: boolean;
  deletedAt: typeof SERVER_TIMESTAMP | null;
  journalNo: string | null;
  status: ReceiptStatus;
  source: string;
  ocrText: string | null;
}

export interface NewReceiptMeta {
  chainId: string;
  storagePath: string;
  sha256: string;
  mimeType: string;
  resolutionOk: boolean;
}

export function buildReceiptDoc(input: ReceiptInput, meta: NewReceiptMeta): ReceiptDoc {
  return {
    kind: input.kind,
    receiptDate: input.receiptDate,
    amount: input.amount,
    vendor: input.vendor,
    category: input.category,
    businessRatio: input.businessRatio,
    project: input.project,
    memo: input.memo,
    receivedDate: input.receivedDate,
    registeredAt: SERVER_TIMESTAMP,
    storagePath: meta.storagePath,
    sha256: meta.sha256,
    mimeType: meta.mimeType,
    resolutionOk: meta.resolutionOk,
    chainId: meta.chainId,
    version: 1,
    prevVersionId: null,
    deleted: false,
    deletedAt: null,
    journalNo: null,
    status: "未記帳",
    source: input.source,
    ocrText: null,
  };
}

export type ReceiptPatch = Partial<
  Pick<
    ReceiptDoc,
    "receiptDate" | "amount" | "vendor" | "category" | "businessRatio" | "project" | "memo" | "journalNo" | "status"
  >
>;

export function buildCorrectionDoc(latest: ReceiptDoc & { docId: string }, patch: ReceiptPatch): ReceiptDoc {
  const { docId, ...latestFields } = latest;
  return {
    ...latestFields,
    ...patch,
    registeredAt: SERVER_TIMESTAMP,
    version: latest.version + 1,
    prevVersionId: docId,
    chainId: latest.chainId,
  };
}
