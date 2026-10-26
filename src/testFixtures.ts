import type { ReceiptWithId } from "./types";
import type { ReceiptChain } from "./useReceipts";

export function receipt(overrides: Partial<ReceiptWithId> = {}): ReceiptWithId {
  return {
    kind: "digital", receiptDate: "2026-10-11", amount: 1000, vendor: "店舗",
    category: null, businessRatio: 50, project: null, memo: null,
    receivedDate: "2026-10-11", storagePath: "original.pdf", sha256: "hash",
    mimeType: "application/pdf", resolutionOk: true, chainId: "id", version: 1,
    prevVersionId: null, deleted: false, deletedAt: null, journalNo: null,
    status: "未記帳", source: "web", ocrText: "", registeredAt: null, docId: "id",
    ...overrides,
  };
}
export function chain(overrides: Partial<ReceiptWithId> = {}): ReceiptChain {
  const latest = receipt(overrides);
  return { chainId: latest.chainId, latest, versions: [latest] };
}
