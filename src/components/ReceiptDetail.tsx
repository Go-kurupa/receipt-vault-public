import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { getDownloadURL, ref } from "firebase/storage";
import { storage } from "../firebase";
import { correctReceipt, updateReceiptStatus } from "../cloudFunctions";
import { RECEIPT_STATUSES, type ReceiptStatus } from "../types";
import type { ReceiptChain } from "../useReceipts";

import { toEditForm, buildChangedPatch, hasUnsavedEdits, type EditForm } from "../receiptEdits";
import { classifyOriginal } from "../receiptFiles";
import { useBackToClose } from "../useBackToClose";
import { createSubmissionRequest } from "../submissionRequest";

interface Props {
  chain: ReceiptChain;
  onClose: () => void;
  onStatusChanged: () => void;
}

const yen = new Intl.NumberFormat("ja-JP");

export function ReceiptDetail({ chain, onClose, onStatusChanged }: Props) {
  const r = chain.latest;
  const [retry, setRetry] = useState(0);
  const originalType = classifyOriginal(r);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState<EditForm>(() => toEditForm(r));
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [statusSubmission] = useState(() => createSubmissionRequest("updateReceiptStatus"));
  const [correctionSubmission] = useState(() => createSubmissionRequest("correctReceipt"));
  const submitting = useRef(false);

  const changedPatch = useMemo(() => buildChangedPatch(editForm, r), [editForm, r]);
  const hasChanges = Object.keys(changedPatch).length > 0;
  const unsavedEdits = hasUnsavedEdits(editForm, r);
  const { close, dismiss } = useBackToClose(true, onClose, () => !submitting.current &&
    (!unsavedEdits || window.confirm("保存していない変更があります。閉じますか？")));

  useEffect(() => {
    let cancelled = false;
    setImgUrl(null);
    setImgError(null);
    if (!r.storagePath) return;
    getDownloadURL(ref(storage, r.storagePath))
      .then((url) => {
        if (!cancelled) setImgUrl(url);
      })
      .catch(() => {
        if (!cancelled) setImgError("原本を読み込めませんでした。通信状況を確認してください。");
      });
    return () => {
      cancelled = true;
    };
  }, [r.storagePath, retry]);

  useEffect(() => {
    setEditMode(false);
    setEditForm(toEditForm(r));
    setStatusError(null);
  }, [r]);

  function updateEditField<K extends keyof EditForm>(key: K, value: EditForm[K]) {
    if (submitting.current) return;
    correctionSubmission.reset();
    setEditForm((current) => ({ ...current, [key]: value }));
  }

  function startEdit() {
    correctionSubmission.reset();
    setEditForm(toEditForm(r));
    setStatusError(null);
    setEditMode(true);
  }

  function cancelEdit() {
    correctionSubmission.reset();
    setEditForm(toEditForm(r));
    setStatusError(null);
    setEditMode(false);
  }

  async function handleStatusChange(newStatus: ReceiptStatus) {
    if (submitting.current || unsavedEdits || newStatus === r.status) return;
    submitting.current = true;
    setStatusBusy(true);
    setStatusError(null);
    try {
      const requestId = await statusSubmission.forInput({ chainId: chain.chainId, status: newStatus }, {
        chainId: chain.chainId, docId: r.docId, version: r.version,
      });
      await updateReceiptStatus(chain.chainId, newStatus, requestId);
      statusSubmission.complete();
      dismiss();
      onStatusChanged();
    } catch (e) {
      statusSubmission.complete(e);
      setStatusError(e instanceof Error ? e.message : String(e));
    } finally {
      submitting.current = false;
      setStatusBusy(false);
    }
  }

  async function handleCorrectionSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const amount = Number(editForm.amount);
    const businessRatio = Number(editForm.businessRatio);

    if (editForm.vendor.trim().length === 0) {
      setStatusError("取引先は空にできません");
      return;
    }
    if (editForm.amount.trim().length === 0 || !Number.isFinite(amount) || amount <= 0) {
      setStatusError("金額は正の数で入力してください");
      return;
    }
    if (editForm.businessRatio.trim().length === 0 || !Number.isFinite(businessRatio) || businessRatio < 0 || businessRatio > 100) {
      setStatusError("事業按分は 0〜100 の数値で入力してください");
      return;
    }
    if (!hasChanges) return;

    submitting.current = true;
    setCorrectionBusy(true);
    setStatusError(null);
    try {
      const requestId = await correctionSubmission.forInput({ chainId: chain.chainId, patch: changedPatch }, {
        chainId: chain.chainId, docId: r.docId, version: r.version,
      });
      await correctReceipt(chain.chainId, changedPatch, requestId);
      correctionSubmission.complete();
      setEditMode(false);
      dismiss();
      onStatusChanged();
    } catch (e) {
      correctionSubmission.complete(e);
      setStatusError(e instanceof Error ? e.message : String(e));
    } finally {
      submitting.current = false;
      setCorrectionBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{r.vendor}</h2>
          <button className="ghost" onClick={close} aria-label="領収書の詳細を閉じる">
            ✕
          </button>
        </div>

        <div className="detail-grid">
          <div className="detail-image">
            {imgError ? (
              <div>
                <p className="error" role="alert">{imgError}</p>
                <button type="button" onClick={() => setRetry((n) => n + 1)}>再読み込み</button>
              </div>
            ) : imgUrl ? (
              originalType === "image" ? (
                <a href={imgUrl} target="_blank" rel="noreferrer">
                  <img src={imgUrl} alt="領収書原本" onError={() => setImgError("画像を表示できませんでした。再読み込みしてください。")} />
                </a>
              ) : (
                <a className="original-link" href={imgUrl} target="_blank" rel="noreferrer">
                  {originalType === "pdf" ? "PDFを開く" : "原本ファイルを開く"}
                </a>
              )
            ) : (
              <p className="muted">{r.storagePath ? "原本読込中…" : "原本ファイルがありません。"}</p>
            )}
          </div>

          <div className="detail-fields">
            {editMode ? (
              <form className="correction-form" onSubmit={handleCorrectionSave}>
                <label>
                  <span>取引年月日</span>
                  <input
                    disabled={correctionBusy}
                    type="date"
                    value={editForm.receiptDate}
                    onChange={(e) => updateEditField("receiptDate", e.target.value)}
                  />
                </label>
                <label>
                  <span>金額</span>
                  <input
                    disabled={correctionBusy}
                    type="number"
                    min="1"
                    step="1"
                    value={editForm.amount}
                    onChange={(e) => updateEditField("amount", e.target.value)}
                  />
                </label>
                <label>
                  <span>取引先</span>
                  <input disabled={correctionBusy} type="text" value={editForm.vendor} onChange={(e) => updateEditField("vendor", e.target.value)} />
                </label>
                <label>
                  <span>勘定科目 (候補)</span>
                  <input
                    disabled={correctionBusy}
                    type="text"
                    value={editForm.category}
                    onChange={(e) => updateEditField("category", e.target.value)}
                  />
                </label>
                <label>
                  <span>事業按分</span>
                  <input
                    disabled={correctionBusy}
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={editForm.businessRatio}
                    onChange={(e) => updateEditField("businessRatio", e.target.value)}
                  />
                </label>
                <label>
                  <span>用途メモ</span>
                  <textarea disabled={correctionBusy} rows={3} value={editForm.memo} onChange={(e) => updateEditField("memo", e.target.value)} />
                </label>
                <div className="correction-actions">
                  <button className="primary" type="submit" disabled={correctionBusy || !hasChanges}>
                    {correctionBusy ? "保存中…" : "保存"}
                  </button>
                  <button className="ghost" type="button" onClick={cancelEdit} disabled={correctionBusy}>
                    キャンセル
                  </button>
                </div>
              </form>
            ) : (
              <>
                <Field label="取引年月日" value={r.receiptDate} />
                <Field label="金額" value={`¥${yen.format(r.amount)}`} />
                <Field label="勘定科目 (候補)" value={r.category ?? "—"} />
                <Field label="事業按分" value={`${r.businessRatio}%`} />
                <Field label="用途メモ" value={r.memo || "—"} />
              </>
            )}
            <Field label="受領日" value={r.receivedDate} />
            <Field label="区分" value={r.kind === "paper" ? "紙" : "電子"} />
            <Field label="証憑ID" value={r.chainId} />

            <div className="field">
              <span className="field-label">状態</span>
              {r.deleted ? (
                <span className="field-value">削除済（状態変更不可）</span>
              ) : (
                <div className="detail-actions">
                  <div className="status-picker">
                    {RECEIPT_STATUSES.map((s) => (
                      <button
                        key={s}
                        className={s === r.status ? "primary" : "ghost"}
                        disabled={statusBusy || correctionBusy || unsavedEdits || s === r.status}
                        onClick={() => handleStatusChange(s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  {!editMode && (
                    <button className="ghost" type="button" onClick={startEdit} disabled={statusBusy || correctionBusy}>
                      編集
                    </button>
                  )}
                </div>
              )}
              {unsavedEdits && <p className="muted small">編集中の内容を保存または取り消してから状態を変更してください</p>}
              {statusError && <p className="error small">{statusError}</p>}
            </div>
          </div>
        </div>

        {chain.versions.length > 1 && (
          <div className="versions">
            <h3>版履歴（訂正・削除の全記録）</h3>
            <div className="table-wrap">
              <table className="versions-table wide">
                <thead>
                  <tr>
                    <th>版</th>
                    <th>取引年月日</th>
                    <th>取引先</th>
                    <th className="num">金額</th>
                    <th>科目</th>
                    <th>メモ</th>
                    <th>状態</th>
                    <th>登録日時</th>
                  </tr>
                </thead>
                <tbody>
                  {chain.versions.map((v) => (
                    <tr key={v.docId}>
                      <td>v{v.version}</td>
                      <td>{v.receiptDate}</td>
                      <td>{v.vendor}</td>
                      <td className="num">¥{yen.format(v.amount)}</td>
                      <td>{v.category ?? "—"}</td>
                      <td className="memo-cell">{v.memo || "—"}</td>
                      <td>{v.deleted ? "削除" : v.status}</td>
                      <td>{v.registeredAt?.toDate().toLocaleString("ja-JP") ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {r.ocrText && (
          <div className="ocr">
            <h3>OCR 原文</h3>
            <pre>{r.ocrText}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="field-value">{value}</span>
    </div>
  );
}
