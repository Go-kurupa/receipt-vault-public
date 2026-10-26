export interface UploadFormInput {
  file: Pick<File, "name" | "size" | "lastModified" | "type"> | null;
  receiptDate: string;
  amount: string;
  vendor: string;
  category: string;
  memo: string;
}

export function hasUnsavedUploadInput(input: UploadFormInput, submitted: boolean): boolean {
  return !submitted && (input.file !== null ||
    [input.receiptDate, input.amount, input.vendor, input.category, input.memo].some((field) => field.length > 0));
}

// 送信する値と同じ正規化を使い、ファイル名・更新日時ではなく原本のバイト列を照合する。
export async function uploadSubmissionInput(input: UploadFormInput, fileBytes: ArrayBuffer, mimeType: string) {
  const category = input.category.trim();
  const memo = input.memo.trim();
  const hash = await crypto.subtle.digest("SHA-256", fileBytes);
  return {
    payload: {
      mimeType,
      receiptDate: input.receiptDate.trim(),
      amount: Number(input.amount),
      vendor: input.vendor.trim(),
      ...(category ? { category } : {}),
      ...(memo ? { memo } : {}),
    },
    fileSha256: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}
