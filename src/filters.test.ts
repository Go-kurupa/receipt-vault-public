import { describe, expect, it } from "vitest";
import { applyFilters, emptyCriteria, monthlySummary, toCsv, toJournalCsv } from "./filters";
import { chain } from "./testFixtures";

describe("CSV の空値とエスケープ", () => {
  it.each([null, undefined])("メモ %s を空欄にする", (memo) => {
    expect(toCsv([chain({ memo })]).split("\r\n")[1]).toBe('"2026-10-11","店舗","1000","","50","","未記帳","","id"');
  });
  it("引用符と改行を保持する", () => {
    expect(toCsv([chain({ memo: '用途"確認"\n次行' })])).toContain('"用途""確認""\n次行"');
  });
  it("科目 null とその他すべての欠落値でも生成できる", () => {
    const c = chain();
    expect(toCsv([c])).toContain('"1000","","50"');
    for (const key of ["receiptDate", "vendor", "amount", "category", "businessRatio", "memo", "status", "chainId"] as const) {
      const missing = { ...c, latest: { ...c.latest, [key]: undefined } } as typeof c;
      expect(toCsv([missing])).not.toContain("undefined");
      expect(() => toJournalCsv([missing])).not.toThrow();
    }
  });
  it("仕訳は削除済みを除外し、按分・空の科目を処理する", () => {
    const csv = toJournalCsv([chain(), chain({ deleted: true })]);
    expect(csv.split("\r\n")).toHaveLength(2);
    expect(csv).toContain('"（科目未設定）","500","事業主借","500","店舗"');
  });
});
it("検索を日付・金額・取引先の組合せで適用する", () => {
  const included = chain();
  const entries = [included, chain({ deleted: true }), chain({ vendor: "別", amount: 100 }), chain({ receiptDate: "2026-09-01" })];
  expect(applyFilters(entries, { ...emptyCriteria, vendor: " 店 ", dateFrom: "2026-10-01", dateTo: "2026-10-31", amountMin: "900", amountMax: "1100" })).toEqual([included]);
  expect(applyFilters(entries, { ...emptyCriteria, includeDeleted: true })).toHaveLength(4);
});
it("月次集計は削除を除外し新しい月順に並ぶ", () => {
  expect(monthlySummary([chain(), chain(), chain({ receiptDate: "2026-09-01" }), chain({ deleted: true })])).toEqual([
    { month: "2026-10", total: 2000, count: 2 }, { month: "2026-09", total: 1000, count: 1 },
  ]);
});
