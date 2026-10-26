import { describe, expect, it, vi } from "vitest";
import {
  createPendingSubmissionStore, createSubmissionRequest, fingerprintSubmission, PENDING_MAX_AGE,
} from "./submissionRequest";
import { uploadSubmissionInput } from "./uploadInput";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

const input = { chainId: "chain", patch: { amount: 100, memo: "用途" } };

it.each([
  { fn: "updateReceiptStatus" as const, first: { status: "記帳済" }, next: { status: "要確認" } },
  { fn: "correctReceipt" as const, first: { patch: { amount: 200 } }, next: { patch: { amount: 300 } } },
])("$fn: 応答消失後、同じ版からの再送は同じID、新しい版からの別操作は新しいIDにする", async ({ fn, first, next }) => {
  const storage = memoryStorage();
  const open = () => createSubmissionRequest(fn, createPendingSubmissionStore(() => storage));
  const original = { chainId: "chain", ...first };
  const base = { chainId: "chain", docId: "doc-v1", version: 1 };
  const submission = open();
  const lostId = await submission.forInput(original, base);
  submission.complete(new Error("response lost"));
  submission.reset();
  expect(await open().forInput(original, base)).toBe(lostId);

  // サーバーでは初回が成功して版が進み、続いて別の値への変更も成功する。
  const changed = open();
  const nextId = await changed.forInput({ chainId: "chain", ...next }, { ...base, docId: "doc-v2", version: 2 });
  changed.complete();
  const newOperationId = await open().forInput({ chainId: "chain", ...first, patch: { amount: 250 } }, { ...base, docId: "doc-v2", version: 2 });
  expect(new Set([lostId, nextId, newOperationId]).size).toBe(3);
});

it("新しい版を送信しても、古い版の未確定な状態変更・訂正を削除しない", async () => {
  const storage = memoryStorage();
  const store = createPendingSubmissionStore(() => storage);
  const base = { chainId: "chain", docId: "doc-v1", version: 1 };
  const status = createSubmissionRequest("updateReceiptStatus", store);
  const correction = createSubmissionRequest("correctReceipt", store);
  const oldStatus = await status.forInput({ status: "記帳済" }, base);
  const oldCorrection = await correction.forInput({ patch: { amount: 200 } }, base);
  const other = await correction.forInput(input, { ...base, chainId: "other" });
  const upload = await createSubmissionRequest("uploadDigitalReceipt", store).forInput({ fileSha256: "hash" });
  const newer = await correction.forInput(input, { ...base, docId: "doc-v3", version: 3 });
  const currentBase = { ...base, docId: "doc-v2", version: 2 };
  const current = await status.forInput({ status: "要確認" }, currentBase);
  const sameVersion = await correction.forInput(input, currentBase);
  const reopened = createPendingSubmissionStore(() => storage);
  expect(await createSubmissionRequest("updateReceiptStatus", reopened).forInput({ status: "要確認" }, currentBase)).toBe(current);
  const ids = JSON.parse([...storage.values.values()][0]).map((entry: { requestId: string }) => entry.requestId);
  expect(ids).toEqual([oldStatus, oldCorrection, other, upload, newer, current, sameVersion]);
});

it("2つのタブで後の訂正が成功しても、古い画面の再送は元の要求IDを再利用する", async () => {
  const storage = memoryStorage();
  const open = () => createSubmissionRequest("correctReceipt", createPendingSubmissionStore(() => storage));
  const baseV1 = { chainId: "chain", docId: "doc-v1", version: 1 };

  // タブAは 100→200 の応答を失い、結果不明のまま要求IDを保留する。
  const tabA = open();
  const staleOperation = { chainId: "chain", patch: { amount: 200 } };
  const originalRequestId = await tabA.forInput(staleOperation, baseV1);
  tabA.complete(new Error("response lost"));
  tabA.reset();

  // タブBは v2 を元に 300 へ訂正し、v3 の成功応答を受け取る。
  const tabB = open();
  const laterRequestId = await tabB.forInput(
    { chainId: "chain", patch: { amount: 300 } },
    { chainId: "chain", docId: "doc-v2", version: 2 },
  );
  tabB.complete();

  // 古い画面から同じ v1 操作を再送しても、新しい要求IDを発行しない。
  expect(await tabA.forInput(staleOperation, baseV1)).toBe(originalRequestId);
  expect(originalRequestId).not.toBe(laterRequestId);
});

it("版番号が同じでも編集元の文書IDが異なれば要求IDを分ける", async () => {
  const storage = memoryStorage();
  const submission = createSubmissionRequest("correctReceipt", createPendingSubmissionStore(() => storage));
  const base = { chainId: "chain", docId: "doc-a", version: 1 };
  const first = await submission.forInput(input, base);
  expect(await submission.forInput(input, { ...base, docId: "doc-b" })).not.toBe(first);
});

it("画面・保管処理を作り直しても、同じ入力の要求IDを再利用する", async () => {
  const storage = memoryStorage();
  const first = createSubmissionRequest("correctReceipt", createPendingSubmissionStore(() => storage));
  const requestId = await first.forInput(input);
  first.complete(new Error("response lost"));
  first.reset();
  const reopened = createSubmissionRequest("correctReceipt", createPendingSubmissionStore(() => storage));
  expect(await reopened.forInput({ patch: { memo: "用途", amount: 100 }, chainId: "chain" })).toBe(requestId);
  expect(requestId).toMatch(/^[A-Za-z0-9-]{36}$/);
  const entries = JSON.parse([...storage.values.values()][0]);
  expect(entries).toEqual([{
    requestId, fingerprint: await fingerprintSubmission(input), fn: "correctReceipt", createdAt: expect.any(Number),
  }]);
  expect(JSON.stringify(entries)).not.toContain("用途");
});

it("処理名・証憑・入力が異なる要求は別のIDを使い、元に戻すと保留IDを再利用する", async () => {
  const storage = memoryStorage();
  const store = createPendingSubmissionStore(() => storage);
  const submission = createSubmissionRequest("correctReceipt", store);
  const first = await submission.forInput(input);
  const changed = await submission.forInput({ ...input, patch: { amount: 200 } });
  const other = await submission.forInput({ ...input, chainId: "other" });
  const status = await createSubmissionRequest("updateReceiptStatus", store).forInput(input);
  expect(new Set([first, changed, other, status]).size).toBe(4);
  submission.reset();
  expect(await submission.forInput(input)).toBe(first);
});

it("7日未満は再利用し、7日経過した記録は読み込み時に削除する", async () => {
  const storage = memoryStorage();
  let time = 1000;
  const fingerprint = await fingerprintSubmission(input);
  const store = createPendingSubmissionStore(() => storage, () => time);
  const first = store.forFingerprint("correctReceipt", fingerprint);
  time += PENDING_MAX_AGE - 1;
  const reopened = createPendingSubmissionStore(() => storage, () => time);
  expect(reopened.forFingerprint("correctReceipt", fingerprint).requestId).toBe(first.requestId);
  expect(reopened.forFingerprint("correctReceipt", fingerprint).createdAt).toBe(1000);
  time++;
  const expired = createPendingSubmissionStore(() => storage, () => time);
  expect(storage.values.size).toBe(0);
  expect(expired.forFingerprint("correctReceipt", fingerprint).requestId).not.toBe(first.requestId);
});

describe("確定応答と結果不明の応答", () => {
  it.each([undefined, ...["invalid-argument", "already-exists", "not-found", "failed-precondition", "permission-denied", "unauthenticated", "out-of-range", "unimplemented"]
    .flatMap((code) => [{ code }, { code: `functions/${code}` }])])("確定応答では保留を削除する: %j", async (error) => {
    const storage = memoryStorage();
    const submission = createSubmissionRequest("correctReceipt", createPendingSubmissionStore(() => storage));
    const first = await submission.forInput(input);
    submission.complete(error);
    expect(storage.values.size).toBe(0);
    expect(await submission.forInput(input)).not.toBe(first);
  });
  it.each([new Error("network"), null, { code: "unknown" }, ...["unavailable", "deadline-exceeded", "internal", "network-request-failed", "aborted", "resource-exhausted"]
    .map((code) => ({ code: `functions/${code}` }))])("結果不明のエラーでは保留を維持する: %j", async (error) => {
    const storage = memoryStorage();
    const submission = createSubmissionRequest("correctReceipt", createPendingSubmissionStore(() => storage));
    const first = await submission.forInput(input);
    submission.complete(error);
    expect(await createSubmissionRequest("correctReceipt", createPendingSubmissionStore(() => storage)).forInput(input)).toBe(first);
  });
  it("他の保留要求を消さず、該当するIDだけを削除する", async () => {
    const storage = memoryStorage();
    const store = createPendingSubmissionStore(() => storage);
    const a = store.forFingerprint("correctReceipt", await fingerprintSubmission(input));
    const b = store.forFingerprint("correctReceipt", await fingerprintSubmission({ ...input, chainId: "other" }));
    store.settle(a.requestId);
    const reloaded = createPendingSubmissionStore(() => storage);
    expect(reloaded.forFingerprint("correctReceipt", b.fingerprint)).toEqual(b);
    expect(reloaded.forFingerprint("correctReceipt", a.fingerprint).requestId).not.toBe(a.requestId);
  });
});

it.each(["getter", "getItem", "setItem", "removeItem"])("保存領域の%sが拒否されても送信と再送を続行する", async (operation) => {
  const storage = memoryStorage();
  if (operation !== "getter") storage[operation as "getItem" | "setItem" | "removeItem"] = () => { throw new Error("denied"); };
  const store = createPendingSubmissionStore(() => {
    if (operation === "getter") throw new Error("denied");
    return storage;
  });
  const submission = createSubmissionRequest("correctReceipt", store);
  const first = await submission.forInput(input);
  submission.reset();
  expect(await submission.forInput(input)).toBe(first);
  submission.complete();
  expect(await submission.forInput(input)).not.toBe(first);
});

it("破損した保存内容でも送信でき、不正な記録を再利用しない", async () => {
  const storage = memoryStorage();
  storage.values.set("receiptVault.pendingSubmissions", "invalid JSON");
  const submission = createSubmissionRequest("correctReceipt", createPendingSubmissionStore(() => storage));
  const id = await submission.forInput(input);
  expect(await submission.forInput(input)).toBe(id);
});

it("読み込み時に期限切れ・不正な記録だけを除き、有効な保留を残す", async () => {
  const storage = memoryStorage();
  const fingerprint = await fingerprintSubmission(input);
  const valid = { requestId: "valid-request", fingerprint, fn: "correctReceipt", createdAt: PENDING_MAX_AGE };
  storage.values.set("receiptVault.pendingSubmissions", JSON.stringify([
    valid,
    { ...valid, requestId: "expired-request", createdAt: 0 },
    { ...valid, requestId: "future-request", createdAt: PENDING_MAX_AGE + 2 },
    { ...valid, requestId: "bad/id" },
    { ...valid, fn: "otherFunction" },
    null,
  ]));
  const store = createPendingSubmissionStore(() => storage, () => PENDING_MAX_AGE + 1);
  expect(JSON.parse([...storage.values.values()][0])).toEqual([valid]);
  expect(store.forFingerprint("correctReceipt", fingerprint).requestId).toBe(valid.requestId);
});

it("原本の内容と送信項目を照合し、原本やbase64を保存しない", async () => {
  const storage = memoryStorage();
  const submission = createSubmissionRequest("uploadDigitalReceipt", createPendingSubmissionStore(() => storage));
  const file = new File([new Uint8Array([0, 255, 128, 10])], "receipt.png", { type: "image/png", lastModified: 123 });
  const form = { file, receiptDate: "2026-10-01", amount: "100", vendor: "取引先", category: "", memo: "用途" };
  const bytes = await file.arrayBuffer();
  const first = await submission.forInput(await uploadSubmissionInput(form, bytes, "image/png"));
  submission.complete(new Error("response lost"));
  const renamed = new File([bytes], "other.png", { type: "image/png", lastModified: 124 });
  const reopened = createSubmissionRequest("uploadDigitalReceipt", createPendingSubmissionStore(() => storage));
  expect(await reopened.forInput(await uploadSubmissionInput({ ...form, file: renamed, amount: "0100" }, await renamed.arrayBuffer(), "image/png"))).toBe(first);
  expect(await submission.forInput(await uploadSubmissionInput(form, new Uint8Array([0, 255, 128, 11]).buffer, "image/png"))).not.toBe(first);
  expect(await submission.forInput(await uploadSubmissionInput(form, bytes, "image/jpeg"))).not.toBe(first);
  expect(await submission.forInput(await uploadSubmissionInput({ ...form, memo: "別の用途" }, bytes, "image/png"))).not.toBe(first);
  const saved = [...storage.values.values()].join("");
  for (const value of ["receipt.png", "取引先", "用途", "fileBase64", "AP+ACg=="]) expect(saved).not.toContain(value);
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128, 10]));
});

it("要求IDは送信時に生成し、同じ要求では再生成しない", async () => {
  const uuid = vi.spyOn(crypto, "randomUUID");
  const storage = memoryStorage();
  const submission = createSubmissionRequest("correctReceipt", createPendingSubmissionStore(() => storage));
  expect(uuid).not.toHaveBeenCalled();
  await submission.forInput(input);
  await submission.forInput(input);
  expect(uuid).toHaveBeenCalledOnce();
  uuid.mockRestore();
});
