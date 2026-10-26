import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ callable: vi.fn(), invoke: vi.fn() }));
vi.mock("firebase/functions", () => ({ httpsCallable: mocks.callable }));
vi.mock("./firebase", () => ({ functions: {} }));

import { arrayBufferToBase64, correctReceipt, updateReceiptStatus, uploadDigitalReceipt } from "./cloudFunctions";
import { createSubmissionRequest } from "./submissionRequest";
import { uploadSubmissionInput } from "./uploadInput";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callable.mockReturnValue(mocks.invoke);
  mocks.invoke.mockResolvedValue({ data: { ok: true, chainId: "chain", docId: "doc", version: 2 } });
});

it("すべての変更呼出しが要求IDを送り、応答の形を維持する", async () => {
  const upload = { fileBase64: "YWJj", mimeType: "image/png", receiptDate: "2026-10-01", amount: 100, vendor: "取引先" };
  const result = await updateReceiptStatus("chain", "記帳済", "status-request");
  await correctReceipt("chain", { memo: "用途" }, "correct-request");
  await uploadDigitalReceipt(upload, "upload-request");
  expect(result).toEqual({ ok: true, chainId: "chain", docId: "doc", version: 2 });
  expect(mocks.callable.mock.calls.map((call) => call[1])).toEqual(["updateReceiptStatus", "correctReceipt", "uploadDigitalReceipt"]);
  expect(mocks.invoke.mock.calls.map((call) => call[0])).toEqual([
    { chainId: "chain", status: "記帳済", requestId: "status-request" },
    { chainId: "chain", patch: { memo: "用途" }, requestId: "correct-request" },
    { ...upload, requestId: "upload-request" },
  ]);
});

it("要求IDを明示しない呼出しにもUUIDを付ける", async () => {
  await updateReceiptStatus("chain", "記帳済");
  await correctReceipt("chain", { memo: "用途" });
  await uploadDigitalReceipt({ fileBase64: "YWJj", mimeType: "image/png", receiptDate: "2026-10-01", amount: 100, vendor: "取引先" });
  const ids = mocks.invoke.mock.calls.map((call) => call[0].requestId);
  for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9-]{36}$/);
  expect(new Set(ids).size).toBe(3);
});

it("通信エラー後も保持した要求IDを送信できる", async () => {
  const submission = createSubmissionRequest("updateReceiptStatus");
  const input = { chainId: "chain", status: "記帳済" as const };
  mocks.invoke.mockRejectedValueOnce(new Error("response lost"));
  const base = { chainId: "chain", docId: "doc-v1", version: 1 };
  await expect(updateReceiptStatus(input.chainId, input.status, await submission.forInput(input, base))).rejects.toThrow("response lost");
  await updateReceiptStatus(input.chainId, input.status, await submission.forInput(input, base));
  expect(mocks.invoke.mock.calls[0][0]).toEqual(mocks.invoke.mock.calls[1][0]);
});

it("base64への変換で全バイト値と分割境界を保持し、原本バイト列を変更しない", () => {
  const bytes = Uint8Array.from({ length: 0x10001 }, (_, index) => index % 256);
  const original = bytes.slice();
  const encoded = arrayBufferToBase64(bytes.buffer);
  expect(new Uint8Array(Buffer.from(encoded, "base64"))).toEqual(original);
  expect(bytes).toEqual(original);
});

it("照合に使った正規化済み項目と同じ原本バイト列を送信し、ファイルのハッシュは送信しない", async () => {
  const bytes = new Uint8Array([0, 255, 128, 10]).buffer;
  const prepared = await uploadSubmissionInput({
    file: null, receiptDate: " 2026-10-01 ", amount: "0100", vendor: " 取引先 ", category: " ", memo: " 用途 ",
  }, bytes, "image/png");
  await uploadDigitalReceipt({ ...prepared.payload, fileBase64: arrayBufferToBase64(bytes) }, "upload-request");
  expect(mocks.invoke).toHaveBeenCalledWith({
    fileBase64: "AP+ACg==", mimeType: "image/png", receiptDate: "2026-10-01",
    amount: 100, vendor: "取引先", memo: "用途", requestId: "upload-request",
  });
});
