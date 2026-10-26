import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import type { ReceiptStatus } from "./types";

interface UpdateStatusResult {
  ok: boolean;
  chainId: string;
  docId: string;
  version: number;
  status: string;
}

export async function updateReceiptStatus(chainId: string, status: ReceiptStatus, requestId: string = crypto.randomUUID()): Promise<UpdateStatusResult> {
  const fn = httpsCallable<{ chainId: string; status: string; requestId: string }, UpdateStatusResult>(functions, "updateReceiptStatus");
  const res = await fn({ chainId, status, requestId });
  return res.data;
}

export interface CorrectReceiptPatch {
  receiptDate?: string;
  amount?: number;
  vendor?: string;
  category?: string;
  businessRatio?: number;
  project?: string;
  memo?: string;
}

interface CorrectReceiptResult {
  ok: boolean;
  chainId: string;
  docId: string;
  version: number;
  patch: CorrectReceiptPatch;
}

export async function correctReceipt(chainId: string, patch: CorrectReceiptPatch, requestId: string = crypto.randomUUID()): Promise<CorrectReceiptResult> {
  const fn = httpsCallable<{ chainId: string; patch: CorrectReceiptPatch; requestId: string }, CorrectReceiptResult>(functions, "correctReceipt");
  const res = await fn({ chainId, patch, requestId });
  return res.data;
}

interface UploadDigitalReceiptInput {
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

interface UploadDigitalReceiptResult {
  ok: boolean;
  chainId: string;
  docId: string;
  version: number;
}

export async function uploadDigitalReceipt(input: UploadDigitalReceiptInput, requestId: string = crypto.randomUUID()): Promise<UploadDigitalReceiptResult> {
  const fn = httpsCallable<UploadDigitalReceiptInput & { requestId: string }, UploadDigitalReceiptResult>(functions, "uploadDigitalReceipt");
  const res = await fn({ ...input, requestId });
  return res.data;
}

// 照合に使った原本のバイト列を加工せず base64 に変換し、ファイルの再読込みを避ける。
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  // 大きな原本でも関数の引数数上限を超えないように分割する。
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}
