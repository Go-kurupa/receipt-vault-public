import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallableRequest } from "firebase-functions/v2/https";
import { FakeFirestore } from "./fakeFirestore";
import { buildReceiptDoc, type ReceiptDoc } from "../src/versioning";

const mocks = vi.hoisted(() => ({ getFirestore: vi.fn(), save: vi.fn(), warn: vi.fn() }));
vi.mock("firebase-admin/app", () => ({ initializeApp: vi.fn(), applicationDefault: vi.fn() }));
vi.mock("firebase-admin/firestore", () => ({ getFirestore: mocks.getFirestore, FieldValue: { serverTimestamp: () => "timestamp" } }));
vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({ bucket: () => ({ file: (path: string) => ({ save: (bytes: Buffer, options: unknown) => mocks.save(path, bytes, options) }) }) }),
}));
vi.mock("firebase-functions", () => ({ logger: { warn: mocks.warn } }));

import { updateReceiptStatus, correctReceipt, uploadDigitalReceipt } from "../src/index";

function request<Data>(data: Data): CallableRequest<Data> {
  return { data, auth: { uid: "owner", token: { email: "owner@example.com", email_verified: true } } } as CallableRequest<Data>;
}

const original: ReceiptDoc = buildReceiptDoc({
  kind: "paper", receiptDate: "2026-10-01", receivedDate: "2026-10-01", amount: 100,
  vendor: "取引先", category: null, businessRatio: 100, project: null, memo: null, source: "discord",
}, { chainId: "chain-id", storagePath: "receipts/2026/chain-id/v1.jpg", sha256: "original-hash", mimeType: "image/jpeg", resolutionOk: true });
const upload = {
  requestId: "upload-request", fileBase64: Buffer.from([0, 255, 128, 10]).toString("base64"),
  mimeType: "image/png", receiptDate: "2026-10-01", amount: 100, vendor: "電子取引先",
};
let db: FakeFirestore;
let objects: Map<string, Buffer>;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  objects = new Map();
  db.documents.set("receipts/cli-random-doc", { ...original });
  mocks.getFirestore.mockReturnValue(db.asFirestore());
  mocks.save.mockImplementation(async (path: string, bytes: Buffer, options: { preconditionOpts: { ifGenerationMatch: number } }) => {
    expect(options.preconditionOpts.ifGenerationMatch).toBe(0);
    if (objects.has(path)) throw Object.assign(new Error("already exists"), { code: 412 });
    objects.set(path, Buffer.from(bytes));
  });
});

function receipts() {
  return [...db.documents].filter(([path]) => path.startsWith("receipts/"));
}

describe("状態変更・訂正", () => {
  it("応答が失われた再送は同じ結果を返し、旧版・ログを変更しない", async () => {
    const data = { chainId: "chain-id", status: "記帳済", requestId: "status-request" };
    const result = await updateReceiptStatus.run(request(data));
    const log = db.documents.get("requestLog/status-request");
    await correctReceipt.run(request({ chainId: "chain-id", patch: { memo: "後続の訂正" }, requestId: "correction-request" }));
    expect(await updateReceiptStatus.run(request(data))).toEqual(result);
    expect(result).toEqual({ ok: true, chainId: "chain-id", docId: expect.any(String), version: 2, status: "記帳済" });
    expect(receipts()).toHaveLength(3);
    expect(db.documents.get("receipts/cli-random-doc")).toEqual(original);
    expect(db.documents.get("requestLog/status-request")).toBe(log);
    expect(log).toMatchObject({ fn: "updateReceiptStatus", ownerEmail: "owner@example.com", createdAt: "timestamp", result });
    expect(db.reads.at(-1)).toBe("requestLog/status-request");
  });
  it("同じ要求IDの同時送信も新版を1件だけ作る", async () => {
    const data = { chainId: "chain-id", status: "記帳済", requestId: "same-request" };
    const [a, b] = await Promise.all([updateReceiptStatus.run(request(data)), updateReceiptStatus.run(request(data))]);
    expect(a).toEqual(b);
    expect(receipts()).toHaveLength(2);
    expect(db.attempts).toBeGreaterThan(2);
  });
  it.each([true, false])("異なる状態変更が競合しても版番号は2,3になる（要求IDあり: %s）", async (withId) => {
    const data = { chainId: "chain-id" };
    const [a, b] = await Promise.all([
      updateReceiptStatus.run(request({ ...data, status: "記帳済", ...(withId ? { requestId: "status-one" } : {}) })),
      updateReceiptStatus.run(request({ ...data, status: "要確認", ...(withId ? { requestId: "status-two" } : {}) })),
    ]);
    expect([a.version, b.version].sort()).toEqual([2, 3]);
    expect(a.docId).not.toBe(b.docId);
    expect(db.documents.get(`receipts/${a.docId}`)?.prevVersionId).toBe("cli-random-doc");
    expect(db.documents.get(`receipts/${b.docId}`)?.prevVersionId).toBe(a.docId);
    expect(db.documents.get("receipts/cli-random-doc")).toEqual(original);
    if (!withId) expect([...db.documents.keys()].some((path) => path.startsWith("requestLog/"))).toBe(false);
  });
  it("状態変更と訂正の競合で双方の変更を保持する", async () => {
    await Promise.all([
      updateReceiptStatus.run(request({ chainId: "chain-id", status: "記帳済", requestId: "status-request" })),
      correctReceipt.run(request({ chainId: "chain-id", patch: { amount: 200, memo: "訂正" }, requestId: "correct-request" })),
    ]);
    const latest = receipts().map(([, doc]) => doc).find((doc) => doc.version === 3);
    expect(latest).toMatchObject({ status: "記帳済", amount: 200, memo: "訂正", storagePath: original.storagePath, sha256: original.sha256 });
  });
  it("訂正の再送とキー順の違いを同一要求として扱う", async () => {
    const data = { chainId: "chain-id", patch: { memo: "用途", amount: 200 }, requestId: "correct-request" };
    const result = await correctReceipt.run(request(data));
    expect(await correctReceipt.run(request({ ...data, patch: { amount: 200, memo: "用途" } }))).toEqual(result);
    expect(result).toEqual({ ok: true, chainId: "chain-id", docId: expect.any(String), version: 2, patch: data.patch });
    expect(receipts()).toHaveLength(2);
    const { patch: _patch, ...minimal } = result;
    expect(db.documents.get("requestLog/correct-request")?.result).toEqual(minimal);
    const log = db.documents.get("requestLog/correct-request");
    await correctReceipt.run(request({ chainId: "chain-id", patch: { vendor: "後続の訂正" }, requestId: "later-request" }));
    expect(await correctReceipt.run(request(data))).toEqual(result);
    expect(db.documents.get("requestLog/correct-request")).toBe(log);
    expect(receipts()).toHaveLength(3);
  });
  it("同じIDの異なる入力・処理を拒否する", async () => {
    await updateReceiptStatus.run(request({ chainId: "chain-id", status: "記帳済", requestId: "shared-request" }));
    await expect(updateReceiptStatus.run(request({ chainId: "chain-id", status: "要確認", requestId: "shared-request" })))
      .rejects.toMatchObject({ code: "already-exists" });
    await expect(correctReceipt.run(request({ chainId: "chain-id", patch: { memo: "用途" }, requestId: "shared-request" })))
      .rejects.toMatchObject({ code: "already-exists" });
    expect(receipts()).toHaveLength(2);
  });
  it("旧形式の訂正ログの再送でも、検証済みの要求から応答を組み立てる", async () => {
    const data = { chainId: "chain-id", patch: { vendor: "取引先", amount: 200, memo: "用途" }, requestId: "correct-request" };
    const result = await correctReceipt.run(request(data));
    const log = db.documents.get("requestLog/correct-request")!;
    db.documents.set("requestLog/correct-request", { ...log, result: { ...result, patch: { memo: "古いログの内容" } } });
    expect(await correctReceipt.run(request(data))).toEqual(result);
    expect(receipts()).toHaveLength(2);
  });
  it("ログ保存の失敗時は証憑も保存せず、再試行できる", async () => {
    db.failNextCommit = true;
    const data = { chainId: "chain-id", patch: { memo: "用途" }, requestId: "correct-request" };
    await expect(correctReceipt.run(request(data))).rejects.toThrow("commit failed");
    expect(receipts()).toHaveLength(1);
    expect(db.documents.has("requestLog/correct-request")).toBe(false);
    expect((await correctReceipt.run(request(data))).version).toBe(2);
  });
  it("旧クライアントの訂正は毎回追記する", async () => {
    const data = { chainId: "chain-id", patch: { memo: "用途" } };
    expect((await correctReceipt.run(request(data))).version).toBe(2);
    expect((await correctReceipt.run(request(data))).version).toBe(3);
    expect([...db.documents.keys()].some((path) => path.startsWith("requestLog/"))).toBe(false);
  });
  it("削除済み・存在しない証憑には追記しない", async () => {
    db.documents.set("receipts/cli-random-doc", { ...original, deleted: true });
    await expect(updateReceiptStatus.run(request({ chainId: "chain-id", status: "記帳済", requestId: "status-request" })))
      .rejects.toMatchObject({ code: "failed-precondition" });
    await expect(correctReceipt.run(request({ chainId: "chain-id", patch: { memo: "用途" }, requestId: "correct-request" })))
      .rejects.toMatchObject({ code: "failed-precondition" });
    await expect(updateReceiptStatus.run(request({ chainId: "missing", status: "記帳済" }))).rejects.toMatchObject({ code: "not-found" });
    expect(db.documents.size).toBe(1);
  });
});

describe("電子領収書登録", () => {
  it("完了後の再送は保存済みの結果を返し、原本を再アップロードしない", async () => {
    const result = await uploadDigitalReceipt.run(request(upload));
    expect(await uploadDigitalReceipt.run(request(upload))).toEqual(result);
    expect(result).toEqual({ ok: true, chainId: expect.any(String), docId: result.chainId, version: 1 });
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(objects.values().next().value).toEqual(Buffer.from(upload.fileBase64, "base64"));
    expect(receipts()).toHaveLength(2);
  });
  it("同時送信は同じ保存先を使い、原本・初版・ログを1件だけ作る", async () => {
    const [a, b] = await Promise.all([uploadDigitalReceipt.run(request(upload)), uploadDigitalReceipt.run(request(upload))]);
    expect(a).toEqual(b);
    expect(mocks.save.mock.calls[0][0]).toBe(mocks.save.mock.calls[1][0]);
    expect(objects.size).toBe(1);
    expect(receipts()).toHaveLength(2);
    expect(mocks.warn).not.toHaveBeenCalled();
  });
  it("原本保存後に確定失敗しても同じ原本を再利用する", async () => {
    db.failNextCommit = true;
    await expect(uploadDigitalReceipt.run(request(upload))).rejects.toThrow("commit failed");
    expect(receipts()).toHaveLength(1);
    expect(objects.size).toBe(1);
    expect(db.documents.has("requestLog/upload-request")).toBe(false);
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
      "原本保存後に証憑の確定に失敗しました。未参照の原本が残る可能性があります",
      { requestId: upload.requestId, storagePath: mocks.save.mock.calls[0][0] },
    );
    await uploadDigitalReceipt.run(request(upload));
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(mocks.save.mock.calls[0][0]).toBe(mocks.save.mock.calls[1][0]);
    expect(objects.size).toBe(1);
    expect(receipts()).toHaveLength(2);
  });
  it("保存済みのIDを別内容に使っても原本を書き換えない", async () => {
    await uploadDigitalReceipt.run(request(upload));
    for (const changed of [{ ...upload, amount: 101 }, { ...upload, fileBase64: Buffer.from("different").toString("base64") }]) {
      await expect(uploadDigitalReceipt.run(request(changed))).rejects.toMatchObject({ code: "already-exists" });
    }
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(objects.values().next().value).toEqual(Buffer.from(upload.fileBase64, "base64"));
  });
  it("同時送信の入力が異なる場合は一方を拒否し、原本を上書きしない", async () => {
    const results = await Promise.allSettled([
      uploadDigitalReceipt.run(request(upload)),
      uploadDigitalReceipt.run(request({ ...upload, fileBase64: Buffer.from("different").toString("base64") })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "already-exists" } });
    expect(objects.size).toBe(2);
    expect(receipts()).toHaveLength(2);
    const doc = receipts().find(([, doc]) => doc.kind === "digital")![1];
    expect(objects.get(doc.storagePath as string)).toEqual(Buffer.from(upload.fileBase64, "base64"));
  });
  it("旧クライアントの登録は毎回異なる証憑と原本を作る", async () => {
    const { requestId: _id, ...legacy } = upload;
    const a = await uploadDigitalReceipt.run(request(legacy));
    const b = await uploadDigitalReceipt.run(request(legacy));
    expect(a.chainId).not.toBe(b.chainId);
    expect(objects.size).toBe(2);
    expect(receipts()).toHaveLength(3);
    expect([...db.documents.keys()].some((path) => path.startsWith("requestLog/"))).toBe(false);
  });
  it("原本保存の通信失敗時は証憑・ログを作らない", async () => {
    mocks.save.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(uploadDigitalReceipt.run(request(upload))).rejects.toThrow("storage unavailable");
    expect(receipts()).toHaveLength(1);
    expect(db.documents.has("requestLog/upload-request")).toBe(false);
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

it("所有者・要求IDの検証はすべての処理で保存前に行う", async () => {
  const calls = [
    () => updateReceiptStatus.run(request({ chainId: "chain-id", status: "記帳済", requestId: "bad/id" })),
    () => correctReceipt.run(request({ chainId: "chain-id", patch: { memo: "用途" }, requestId: null })),
    () => uploadDigitalReceipt.run(request({ ...upload, requestId: "bad/id" })),
  ];
  for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "invalid-argument" });
  await expect(uploadDigitalReceipt.run({ ...request(upload), auth: undefined })).rejects.toMatchObject({ code: "permission-denied" });
  expect(db.attempts).toBe(0);
  expect(mocks.save).not.toHaveBeenCalled();
});
