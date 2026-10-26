import { expect, it } from "vitest";
import { authErrorMessage } from "./authErrors";
it.each([
  ["auth/popup-blocked", "ポップアップを許可"],
  ["auth/popup-closed-by-user", "閉じられました"],
  ["auth/cancelled-popup-request", "重複"],
  ["auth/network-request-failed", "インターネット接続"],
  ["auth/unauthorized-domain", "管理者"],
  ["auth/unknown", "ログインできませんでした"],
])("認証エラー %s の案内", (code, guidance) => {
  expect(authErrorMessage({ code })).toContain(guidance);
  expect(authErrorMessage(code)).toContain(guidance);
});
it("未知の例外も日本語の案内になる", () => {
  for (const value of [null, undefined, new Error("private"), {}]) expect(authErrorMessage(value)).toContain("ログインできませんでした");
});
