import { expect, test } from "vitest";
import { readChainParam } from "./deepLink";
test("?chain= の値を返す", () => {
  expect(readChainParam("?chain=abc123")).toBe("abc123");
  expect(readChainParam("")).toBeNull();
  expect(readChainParam("?chain=")).toBeNull();
  expect(readChainParam("?chain=a/b")).toBeNull(); // Firestore の docId に使えない文字は拒否
});
