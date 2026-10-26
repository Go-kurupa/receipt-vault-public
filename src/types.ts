import type { Timestamp } from "firebase/firestore";

export type ReceiptStatus = "未記帳" | "記帳済" | "要確認";
export const RECEIPT_STATUSES: ReceiptStatus[] = ["未記帳", "記帳済", "要確認"];

// receipt-vault CLI (src/versioning.ts) が書き込む Firestore ドキュメント形。
// 追記専用: 訂正・削除は新しい version ドキュメントの追加として表現される。
export interface ReceiptDoc {
  kind: "paper" | "digital";
  receiptDate: string; // YYYY-MM-DD 取引年月日 (法定検索項目①)
  amount: number; // 税込整数 (法定検索項目②)
  vendor: string; // 取引先 (法定検索項目③)
  category: string | null;
  businessRatio: number;
  project: string | null;
  memo: string | null;
  receivedDate: string;
  storagePath: string;
  sha256: string;
  mimeType: string;
  resolutionOk: boolean;
  chainId: string; // 版グループのキー (初版 docId)
  version: number;
  prevVersionId: string | null;
  deleted: boolean;
  deletedAt: Timestamp | null;
  journalNo: string | null;
  status: ReceiptStatus;
  source: string;
  ocrText: string;
  registeredAt: Timestamp | null;
}

// Firestore の docId を付与した実体。
export type ReceiptWithId = ReceiptDoc & { docId: string };
