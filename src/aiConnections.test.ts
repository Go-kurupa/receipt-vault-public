import { expect, test, vi } from "vitest";
vi.mock("./firebase", () => ({ functions: {} }));
import { acceptMinutesLeft, canOrganize, describeOrigin, describeScopes, errorMessage, formatJstDate, readRequestParam } from "./aiConnections";

test("権限の表示", () => {
  expect(describeScopes(["receipts:read", "receipts:organize"])).toBe("読む＋整理");
  expect(describeScopes(["receipts:read"])).toBe("読む");
  expect(describeScopes([])).toBe("なし");
  expect(canOrganize({ scopes: ["receipts:read"] })).toBe(false);
});

test("作成元の表示", () => {
  expect(describeOrigin("web")).toBe("この画面");
  expect(describeOrigin("issue-key-script")).toBe("コマンド");
  expect(describeOrigin(null)).toBe("不明");
});

test("日付は日本時間で表示する（UTC 15時以降は翌日）", () => {
  expect(formatJstDate("2026-10-12T15:30:00.000Z")).toBe("2026-10-13");
  expect(formatJstDate("2026-10-12T06:51:06.431Z")).toBe("2026-10-12");
  expect(formatJstDate(null)).toBe("—");
  expect(formatJstDate("bad")).toBe("—");
});

test("エラー表示は日本語のサーバー文言を優先し、英語の内部文言は出さない", () => {
  expect(errorMessage({ code: "functions/already-exists", message: "同じ名前の接続がすでにあります" })).toBe("同じ名前の接続がすでにあります");
  expect(errorMessage({ code: "functions/permission-denied", message: "x" })).toBe("このアカウントには権限がありません");
  expect(errorMessage({ code: "functions/internal", message: "INTERNAL" })).toBe("処理に失敗しました。時間をおいて再度お試しください");
  expect(errorMessage(null)).toBe("処理に失敗しました。時間をおいて再度お試しください");
});

test("受付の残り時間は切り上げ、閉じていれば 0", () => {
  expect(acceptMinutesLeft(0, 1000)).toBe(0);
  expect(acceptMinutesLeft(10 * 60_000, 0)).toBe(10);
  expect(acceptMinutesLeft(61_000, 0)).toBe(2);
  expect(acceptMinutesLeft(500, 1000)).toBe(0);
});

test("許可画面の要求 ID は安全な形だけ", () => {
  expect(readRequestParam("?request=8f1c-abc_D")).toBe("8f1c-abc_D");
  expect(readRequestParam("?request=../x")).toBeNull();
  expect(readRequestParam("")).toBeNull();
});
