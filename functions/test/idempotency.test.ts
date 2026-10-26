import { describe, expect, it } from "vitest";
import { createHash } from "crypto";
import { canonicalJson, hashPayload, validateRequestId, decideRequestLog, minimalRequestResult } from "../src/idempotency";

it("要求ログには結果の識別情報と状態だけを残し、訂正内容を除外する", () => {
  const minimal = { ok: true, chainId: "chain", docId: "doc", version: 2 };
  const full = { ...minimal, status: "記帳済", patch: { vendor: "取引先", amount: 100, memo: "用途" }, memo: "余分な内容" };
  expect(minimalRequestResult(full, "correctReceipt")).toEqual(minimal);
  expect(minimalRequestResult(full, "uploadDigitalReceipt")).toEqual(minimal);
  expect(minimalRequestResult(full, "updateReceiptStatus")).toEqual({ ...minimal, status: "記帳済" });
});

describe("要求IDの検証", () => {
  it("省略と8〜100文字の英数字・ハイフンを受け付ける", () => {
    expect(validateRequestId(undefined)).toBeUndefined();
    for (const value of ["Abcd-123", "a".repeat(100), "cf87a510-c9c1-43bc-9ee9-819ec00b54c1"]) {
      expect(validateRequestId(value)).toBe(value);
    }
  });
  it.each([null, 123, {}, "", "1234567", "a".repeat(101), "abcdefgh/", "abcdefgh_", "abcdefgh\n", "abcdefgh ", "abcdefghあ"])(
    "不正なIDを拒否する: %j", (value) => {
      expect(() => validateRequestId(value)).toThrow(expect.objectContaining({ code: "invalid-argument" }));
    },
  );
});

describe("入力内容の正規化とハッシュ", () => {
  it("キー順によらず入れ子を正規化し、配列順・日本語・空値を保持する", () => {
    expect(canonicalJson({ z: [{ b: 2, a: "領収書" }], a: null })).toBe('{"a":null,"z":[{"a":"領収書","b":2}]}');
    expect(hashPayload({ patch: { memo: "用途", amount: 100 }, chainId: "chain" }))
      .toBe(hashPayload({ chainId: "chain", patch: { amount: 100, memo: "用途" } }));
    expect(hashPayload({ values: [1, 2] })).not.toBe(hashPayload({ values: [2, 1] }));
    expect(hashPayload({ memo: null })).not.toBe(hashPayload({ memo: "" }));
    expect(hashPayload({ memo: "" })).not.toBe(hashPayload({}));
    expect(hashPayload({ amount: 100 })).toBe(createHash("sha256").update('{"amount":100}').digest("hex"));
  });
  it("最上位の要求IDのみ除外し、入力変更を区別する", () => {
    expect(hashPayload({ requestId: "request-1", chainId: "a" })).toBe(hashPayload({ requestId: "request-2", chainId: "a" }));
    expect(hashPayload({ chainId: "a" })).not.toBe(hashPayload({ chainId: "b" }));
    expect(hashPayload({ patch: { requestId: "a" } })).not.toBe(hashPayload({ patch: { requestId: "b" } }));
  });
  it("base64表記ではなく原本バイト列で比較する", () => {
    const bytes = Buffer.from([0, 255, 128, 10]);
    const data = { fileBase64: bytes.toString("base64"), mimeType: "image/png", amount: 100 };
    expect(hashPayload(data, bytes)).toBe(hashPayload({ ...data, fileBase64: "別の表記" }, Buffer.from(bytes)));
    expect(hashPayload(data, bytes)).not.toBe(hashPayload(data, Buffer.from([1, 255, 128, 10])));
    expect(hashPayload(data, bytes)).not.toBe(hashPayload({ ...data, amount: 101 }, bytes));
    expect(hashPayload(data, bytes)).not.toBe(hashPayload({ ...data, mimeType: "image/jpeg" }, bytes));
  });
});

describe("既存要求ログの判定", () => {
  const identity = { fn: "correctReceipt", payloadHash: "hash" };
  const result = { ok: true, chainId: "chain", docId: "random-doc", version: 2, patch: { memo: "用途" } };
  it("未実行なら新規作成、同一要求なら保存済み結果を返す", () => {
    expect(decideRequestLog(undefined, identity)).toEqual({ kind: "create" });
    expect(decideRequestLog({ ...identity, result }, identity)).toEqual({ kind: "replay", result });
  });
  it.each([{ fn: "uploadDigitalReceipt", payloadHash: "hash" }, { fn: "correctReceipt", payloadHash: "changed" }])(
    "処理・入力の異なる要求IDを拒否する", (other) => {
      expect(() => decideRequestLog({ ...other, result }, identity)).toThrow(expect.objectContaining({ code: "already-exists" }));
    },
  );
});
