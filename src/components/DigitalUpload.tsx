import { useEffect, useRef, useState, type RefObject } from "react";
import { useBackToClose } from "../useBackToClose";
import { ALLOWED_MIME, UPLOAD_GUIDANCE, validateUploadFile } from "../receiptFiles";
import { arrayBufferToBase64, uploadDigitalReceipt } from "../cloudFunctions";
import { createSubmissionRequest } from "../submissionRequest";
import { hasUnsavedUploadInput, uploadSubmissionInput } from "../uploadInput";

interface Props {
  onUploaded: () => void;
  canLeaveRef?: RefObject<(() => boolean) | null>;
}

export function DigitalUpload({ onUploaded, canLeaveRef }: Props) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [receiptDate, setReceiptDate] = useState("");
  const [amount, setAmount] = useState("");
  const [vendor, setVendor] = useState("");
  const [category, setCategory] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const submitting = useRef(false);
  const [submission] = useState(() => createSubmissionRequest("uploadDigitalReceipt"));
  const input = { file, receiptDate, amount, vendor, category, memo };
  const canClose = () => !submitting.current &&
    (!hasUnsavedUploadInput(input, !!result) || window.confirm("入力中の内容があります。破棄して閉じますか？"));
  const { close } = useBackToClose(open, () => { setOpen(false); reset(); }, canClose);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!canLeaveRef) return;
    canLeaveRef.current = canClose;
    return () => { canLeaveRef.current = null; };
  });

  function reset() {
    submission.reset();
    setFile(null);
    setReceiptDate("");
    setAmount("");
    setVendor("");
    setCategory("");
    setMemo("");
    setError(null);
    setResult(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting.current || result) return;
    if (!file) {
      setError("ファイルを選択してください");
      return;
    }
    const validation = validateUploadFile(file);
    if (validation.error !== null) {
      setError(validation.error);
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const fileBytes = await file.arrayBuffer();
      const submissionInput = await uploadSubmissionInput(input, fileBytes, validation.mimeType);
      const requestId = await submission.forInput(submissionInput);
      const res = await uploadDigitalReceipt({
        ...submissionInput.payload,
        fileBase64: arrayBufferToBase64(fileBytes),
      }, requestId);
      submission.complete();
      setResult(`登録しました（証憑ID: ${res.chainId}）`);
      onUploaded();
    } catch (e2) {
      submission.complete(e2);
      setError(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="ghost" onClick={() => setOpen(true)}>
        ＋ 電子領収書を追加
      </button>
    );
  }

  return (
    <form className="digital-upload" onSubmit={handleSubmit}>
      <div className="digital-upload-head">
        <h3>電子取引データの登録</h3>
        <button type="button" className="ghost" onClick={close} disabled={busy} aria-label="登録画面を閉じる">
          ✕
        </button>
      </div>
      <p className="muted small">Amazon 等の PDF 領収書や、クラウドサービスの利用明細画像を登録します。</p>

      <p className="muted small">紙のレシートは Discord に送ってください（この画面は電子領収書専用です）</p>
      <p className="muted small">{UPLOAD_GUIDANCE} 形式の情報がない場合は拡張子から判定します。</p>
      <fieldset disabled={busy || !!result}>
        <div className="filter-row">
          <label>
            ファイル (PDF/JPEG/PNG)
            <input
              ref={fileInput}
              type="file"
              accept={Object.keys(ALLOWED_MIME).join(",")}
              onChange={(e) => { submission.reset(); setFile(e.target.files?.[0] ?? null); }}
            />
          </label>
          <label>
            取引年月日
            <input type="date" value={receiptDate} onChange={(e) => { submission.reset(); setReceiptDate(e.target.value); }} required />
          </label>
          <label>
            金額
            <input
              type="number"
              min="1"
              value={amount}
              onChange={(e) => { submission.reset(); setAmount(e.target.value); }}
              required
            />
          </label>
          <label>
            取引先
            <input type="text" value={vendor} onChange={(e) => { submission.reset(); setVendor(e.target.value); }} required />
          </label>
          <label>
            勘定科目 (任意)
            <input type="text" value={category} onChange={(e) => { submission.reset(); setCategory(e.target.value); }} />
          </label>
        </div>
        <label className="memo-field">
          メモ (任意)
          <input type="text" value={memo} onChange={(e) => { submission.reset(); setMemo(e.target.value); }} />
        </label>
      </fieldset>
      <div className="filter-actions">
        <button className="primary" type="submit" disabled={busy || !!result}>
          {result ? "送信済み" : busy ? "登録中…" : "登録する"}
        </button>
        {error && <span className="error small">{error}</span>}
        {result && <>
          <span className="small" role="status">{result}</span>
          <button type="button" className="ghost" onClick={reset}>続けて登録する</button>
        </>}
      </div>
    </form>
  );
}
