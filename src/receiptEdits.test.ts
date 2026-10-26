import { expect, it } from "vitest";
import { toEditForm, buildChangedPatch, hasUnsavedEdits } from "./receiptEdits";
import { receipt } from "./testFixtures";
it("空のメモ・科目を編集でき、変更なしなら訂正しない", () => {
  const r = receipt();
  expect(toEditForm(r)).toMatchObject({ memo: "", category: "" });
  expect(buildChangedPatch(toEditForm(r), r)).toEqual({});
  expect(hasUnsavedEdits(toEditForm(r), r)).toBe(false);
});
it("無効な数値や数値が同じでも表記の異なる入力を未保存として検出する", () => {
  const r = receipt();
  for (const amount of ["bad", "", "01000"]) {
    expect(hasUnsavedEdits({ ...toEditForm(r), amount }, r)).toBe(true);
  }
});
it("変更された項目だけ訂正する", () => {
  const r = receipt();
  const form = { receiptDate: "2026-09-01", vendor: "変更", amount: "2000", businessRatio: "100", category: "消耗品費", memo: "用途" };
  expect(buildChangedPatch(form, r)).toEqual({ ...form, amount: 2000, businessRatio: 100 });
  expect(buildChangedPatch({ ...toEditForm(r), amount: "bad", businessRatio: "bad" }, r)).toEqual({});
});
