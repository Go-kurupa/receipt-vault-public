import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("全画面で他サイトへの埋め込みを禁止する（クリックジャッキング対策・review M1）", () => {
  const config = JSON.parse(readFileSync(new URL("../firebase.json", import.meta.url), "utf8"));
  const all = (config.hosting.headers ?? []).find((h: { source: string }) => h.source === "**");
  const headers = Object.fromEntries((all?.headers ?? []).map((h: { key: string; value: string }) => [h.key, h.value]));
  expect(headers["X-Frame-Options"]).toBe("DENY");
  expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
});
