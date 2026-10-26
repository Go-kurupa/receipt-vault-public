import type { ReceiptChain } from "./useReceipts";
import type { CorrectReceiptPatch } from "./cloudFunctions";

export interface EditForm {
  receiptDate: string;
  amount: string;
  vendor: string;
  category: string;
  businessRatio: string;
  memo: string;
}

export function toEditForm(r: ReceiptChain["latest"]): EditForm {
  return {
    receiptDate: r.receiptDate,
    amount: String(r.amount),
    vendor: r.vendor,
    category: r.category ?? "",
    businessRatio: String(r.businessRatio),
    memo: r.memo ?? "",
  };
}

// 数値として無効な入力も、失われる編集として検知する。
export function hasUnsavedEdits(form: EditForm, r: ReceiptChain["latest"]): boolean {
  const initial = toEditForm(r);
  return (Object.keys(initial) as (keyof EditForm)[]).some((key) => form[key] !== initial[key]);
}

export function buildChangedPatch(form: EditForm, r: ReceiptChain["latest"]): CorrectReceiptPatch {
  const patch: CorrectReceiptPatch = {};
  const amount = Number(form.amount);
  const businessRatio = Number(form.businessRatio);

  if (form.receiptDate !== r.receiptDate) patch.receiptDate = form.receiptDate;
  if (Number.isFinite(amount) && amount !== r.amount) patch.amount = amount;
  if (form.vendor !== r.vendor) patch.vendor = form.vendor;
  if (form.category !== (r.category ?? "")) patch.category = form.category;
  if (Number.isFinite(businessRatio) && businessRatio !== r.businessRatio) patch.businessRatio = businessRatio;
  if (form.memo !== (r.memo ?? "")) patch.memo = form.memo;

  return patch;
}
