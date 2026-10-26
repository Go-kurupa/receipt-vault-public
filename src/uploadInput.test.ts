import { expect, it } from "vitest";
import { hasUnsavedUploadInput, uploadSubmissionInput, type UploadFormInput } from "./uploadInput";
import { fingerprintSubmission } from "./submissionRequest";

const empty: UploadFormInput = { file: null, receiptDate: "", amount: "", vendor: "", category: "", memo: "" };

it("空の登録フォームは未保存扱いにしない", () => {
  expect(hasUnsavedUploadInput(empty, false)).toBe(false);
});

it.each(["receiptDate", "amount", "vendor", "category", "memo"] as const)("%sだけの入力も保護する", (field) => {
  expect(hasUnsavedUploadInput({ ...empty, [field]: "入力" }, false)).toBe(true);
  expect(hasUnsavedUploadInput({ ...empty, [field]: " " }, false)).toBe(true);
});

it("ファイルだけ選択した場合も保護し、成功後は確認を不要にする", () => {
  const filled = { ...empty, file: { name: "receipt.pdf", size: 10, lastModified: 1, type: "application/pdf" } };
  expect(hasUnsavedUploadInput(filled, false)).toBe(true);
  expect(hasUnsavedUploadInput({ ...filled, vendor: "取引先", memo: "用途" }, true)).toBe(false);
});

const form = {
  file: new File([new Uint8Array([0, 255, 128, 10])], "receipt.png", { type: "image/png", lastModified: 123 }),
  receiptDate: "2026-10-01", amount: "100", vendor: "取引先", category: "", memo: "",
};

async function fingerprint(input: typeof form) {
  return fingerprintSubmission(await uploadSubmissionInput(input, await input.file.arrayBuffer(), "image/png"));
}

it("同じ原本バイト列ならファイル名・更新日時が異なっても同じ照合値になる", async () => {
  const renamed = new File([await form.file.arrayBuffer()], "renamed.png", { type: "image/png", lastModified: 456 });
  expect(await fingerprint({ ...form, file: renamed })).toBe(await fingerprint(form));
});

it("名前・サイズ・更新日時・形式が同じでも原本バイト列が異なれば照合値を分ける", async () => {
  const replaced = new File([new Uint8Array([0, 255, 128, 11])], form.file.name, { type: form.file.type, lastModified: form.file.lastModified });
  expect(replaced.size).toBe(form.file.size);
  expect(await fingerprint({ ...form, file: replaced })).not.toBe(await fingerprint(form));
});

it("100と0100は同じ照合値になり、文字列の前後空白と空の任意項目も正規化する", async () => {
  expect(await fingerprint({ ...form, amount: "0100" })).toBe(await fingerprint(form));
  expect(await fingerprint({ ...form, amount: " 100 ", receiptDate: " 2026-10-01 ", vendor: " 取引先 ", category: " ", memo: " " })).toBe(await fingerprint(form));
  expect(await fingerprint({ ...form, amount: "200" })).not.toBe(await fingerprint(form));
  expect(await fingerprint({ ...form, memo: "用途" })).not.toBe(await fingerprint(form));
});

it("送信用の値を数値・空白除去・任意項目省略で揃え、原本のSHA-256だけを照合に渡す", async () => {
  const bytes = new TextEncoder().encode("abc").buffer;
  const prepared = await uploadSubmissionInput({ ...form, amount: "0100", vendor: " 取引先 ", category: " ", memo: " " }, bytes, "image/png");
  expect(prepared).toEqual({
    payload: { mimeType: "image/png", receiptDate: "2026-10-01", amount: 100, vendor: "取引先" },
    fileSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
  expect(new TextDecoder().decode(bytes)).toBe("abc");
  const filled = await uploadSubmissionInput({ ...form, category: " 通信費 ", memo: " 用途 " }, bytes, "image/png");
  expect(filled.payload).toEqual({ ...prepared.payload, category: "通信費", memo: "用途" });
  const otherMime = await uploadSubmissionInput(form, bytes, "application/pdf");
  expect(await fingerprintSubmission(otherMime)).not.toBe(await fingerprintSubmission(prepared));
});
