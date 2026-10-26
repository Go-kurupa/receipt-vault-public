// サーバーの MAX_UPLOAD_BYTES / ALLOWED_MIME と同じ制限。原本は加工しない。
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const ALLOWED_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};
export const UPLOAD_GUIDANCE = "上限は8 MiB（8,388,608バイト）、対応形式はPDF・JPEG・PNGです。";

function mimeFromPath(path: string): string {
  const extension = path.split(/[?#]/, 1)[0].split(".").pop()?.toLowerCase();
  if (extension === "pdf") return "application/pdf";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  return "";
}

export function classifyOriginal(receipt: { storagePath?: string | null; mimeType?: string | null }): "pdf" | "image" | "unknown" {
  const mime = receipt.mimeType?.toLowerCase() || mimeFromPath(receipt.storagePath ?? "");
  // PDF の拡張子が残る古い書類も画像として描画しない。
  if (mime === "application/pdf" || mimeFromPath(receipt.storagePath ?? "") === "application/pdf") return "pdf";
  if (mime === "image/jpeg" || mime === "image/png") return "image";
  return "unknown";
}

export function validateUploadFile(file: { size: number; type: string; name: string }):
  { mimeType: string; error: null } | { mimeType: null; error: string } {
  if (file.size === 0) return { mimeType: null, error: `空のファイルは登録できません。${UPLOAD_GUIDANCE}` };
  if (file.size > MAX_UPLOAD_BYTES) return { mimeType: null, error: `ファイルが大きすぎます。${UPLOAD_GUIDANCE}` };
  // MIME が空のときだけ拡張子で補う。明示された未対応 MIME は拒否する。
  const mimeType = file.type || mimeFromPath(file.name);
  if (!Object.hasOwn(ALLOWED_MIME, mimeType)) return { mimeType: null, error: `ファイル形式を確認してください。${UPLOAD_GUIDANCE}` };
  return { mimeType, error: null };
}
