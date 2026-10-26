import { describe, expect, test } from 'vitest';
import { groupChains, isRegisteredLate, searchChains, summarize, toRecord, type ReceiptRecord } from './receipts-pure';

const base = {
  kind: 'paper', receiptDate: '2026-08-08', amount: 1000, vendor: '大原ふれあいマーケット店',
  category: null, businessRatio: 100, project: null, memo: null, receivedDate: '2026-08-08',
  status: '未記帳', journalNo: null, deleted: false, source: 'discord', mimeType: 'image/jpeg',
  sha256: 'x', ocrText: null,
};
const rec = (docId: string, over: Record<string, unknown>): ReceiptRecord =>
  toRecord(docId, { ...base, chainId: 'c1', version: 1, ...over })!;

describe('toRecord', () => {
  test('null の memo / category / project と registeredAt 欠落で落ちない', () => {
    const r = toRecord('d', { ...base, chainId: 'c', version: 1 });
    expect(r).toMatchObject({ memo: null, category: null, project: null, registeredAt: null });
  });
  test('Timestamp 風の registeredAt を ISO に変換', () => {
    const r = toRecord('d', { ...base, chainId: 'c', version: 1, registeredAt: { toDate: () => new Date('2026-08-08T01:00:00Z') } });
    expect(r?.registeredAt).toBe('2026-08-08T01:00:00.000Z');
  });
  test('事業按分率が NaN・Infinity・0〜100 の範囲外なら null（欠落は 100）', () => {
    for (const businessRatio of [NaN, Infinity, -1, 101]) expect(toRecord('d', { ...base, chainId: 'c', version: 1, businessRatio })).toBeNull();
    const { businessRatio: _omit, ...noRatio } = base;
    expect(toRecord('d', { ...noRatio, chainId: 'c', version: 1 })?.businessRatio).toBe(100);
  });
  test('chainId・version・amount が壊れた行は null', () => {
    expect(toRecord('d', { ...base, version: 1 })).toBeNull();
    expect(toRecord('d', { ...base, chainId: 'c' })).toBeNull();
    expect(toRecord('d', { ...base, chainId: 'c', version: 1, amount: '1000' })).toBeNull();
  });
});

describe('groupChains / searchChains', () => {
  const v1 = rec('a', { version: 1, receiptDate: '2026-07-01', registeredAt: { toDate: () => new Date('2026-07-02T00:00:00Z') } });
  const v2 = rec('b', { version: 2, receiptDate: '2026-08-01', prevVersionId: 'a', registeredAt: { toDate: () => new Date('2026-08-02T00:00:00Z') } });
  const del = rec('z', { chainId: 'c2', version: 2, deleted: true });
  const chains = groupChains([v1, v2, rec('y', { chainId: 'c2', version: 1 }), del]);

  test('最新版でまとめる', () => {
    expect(chains.find((c) => c.chainId === 'c1')?.latest.docId).toBe('b');
    expect(chains.find((c) => c.chainId === 'c1')?.versions.map((v) => v.version)).toEqual([2, 1]);
  });
  test('訂正後の日付で検索する（古い版の日付では当たらない）', () => {
    expect(searchChains(chains, { dateFrom: '2026-07-01', dateTo: '2026-07-31' })).toHaveLength(0);
    expect(searchChains(chains, { dateFrom: '2026-08-01', dateTo: '2026-08-31' }).map((c) => c.chainId)).toEqual(['c1']);
  });
  test('削除済みは既定で除外し、includeDeleted で含める', () => {
    expect(searchChains(chains, {}).map((c) => c.chainId)).toEqual(['c1']);
    expect(searchChains(chains, { includeDeleted: true })).toHaveLength(2);
  });
  test('取引先は全角半角・大文字小文字を無視した部分一致', () => {
    const c = groupChains([rec('q', { chainId: 'c3', vendor: 'ＢＡＳＥ 101%' })]);
    expect(searchChains(c, { vendor: 'base' })).toHaveLength(1);
  });
  test('金額範囲・種別・状態・科目の組合せ', () => {
    const c = groupChains([
      rec('m', { chainId: 'm', amount: 500, kind: 'digital', status: '記帳済', category: '旅費交通費' }),
      rec('n', { chainId: 'n', amount: 5000, kind: 'digital', status: '記帳済', category: '旅費交通費' }),
    ]);
    expect(searchChains(c, { amountMin: 1000, kind: 'digital', status: '記帳済', category: '旅費交通費' }).map((x) => x.chainId)).toEqual(['n']);
  });
});

describe('summarize / isRegisteredLate', () => {
  test('月別合計と按分後合計。削除済みは除外。科目なしは「（未設定）」', () => {
    const c = groupChains([
      rec('a', { chainId: 'a', receiptDate: '2026-08-31', amount: 1000, businessRatio: 50 }),
      rec('b', { chainId: 'b', receiptDate: '2026-09-01', amount: 300 }),
      rec('d', { chainId: 'd', receiptDate: '2026-08-01', amount: 9999, deleted: true }),
    ]);
    expect(summarize(c, 'month')).toEqual([
      { key: '2026-09', total: 300, businessTotal: 300, count: 1 },
      { key: '2026-08', total: 1000, businessTotal: 500, count: 1 },
    ]);
    expect(summarize(c, 'category')[0].key).toBe('（未設定）');
  });
  test('紙で受領日から 67 日超の登録だけ遅延扱い。電子は対象外', () => {
    const at = (iso: string) => ({ toDate: () => new Date(iso) });
    const one = (r: ReceiptRecord) => groupChains([r])[0]!;
    expect(isRegisteredLate(one(rec('a', { receivedDate: '2026-07-01', registeredAt: at('2026-09-06T00:00:00Z') })))).toBe(false); // 67 日
    expect(isRegisteredLate(one(rec('b', { receivedDate: '2026-07-01', registeredAt: at('2026-09-07T00:00:00Z') })))).toBe(true); // 68 日
    expect(isRegisteredLate(one(rec('c', { kind: 'digital', receivedDate: '2026-01-01', registeredAt: at('2026-09-07T00:00:00Z') })))).toBe(false);
  });
  test('訂正（状態変更）で登録日時が新しくなっても、初版の登録日時で判定する', () => {
    const at = (iso: string) => ({ toDate: () => new Date(iso) });
    const chain = groupChains([
      rec('a', { version: 1, receivedDate: '2026-07-01', registeredAt: at('2026-07-02T00:00:00Z') }),
      rec('b', { version: 2, receivedDate: '2026-07-01', status: '記帳済', registeredAt: at('2026-10-01T00:00:00Z') }),
    ])[0]!;
    expect(isRegisteredLate(chain)).toBe(false);
    const late = groupChains([
      rec('a', { version: 1, receivedDate: '2026-07-01', registeredAt: at('2026-09-30T00:00:00Z') }),
      rec('b', { version: 2, receivedDate: '2026-07-01', status: '記帳済', registeredAt: at('2026-10-01T00:00:00Z') }),
    ])[0]!;
    expect(isRegisteredLate(late)).toBe(true);
  });
});

import { applyFilters, monthlySummary, emptyCriteria } from '../../src/filters';
test('画面の applyFilters / monthlySummary と同じ結果', () => {
  const recs = [
    rec('a', { chainId: 'a', receiptDate: '2026-08-08', amount: 25660, vendor: 'あわくら温泉元湯' }),
    rec('b', { chainId: 'b', receiptDate: '2026-07-01', amount: 3000, vendor: '西粟倉村' }),
    rec('c', { chainId: 'c', receiptDate: '2026-08-10', amount: 32100, vendor: 'サンプル取引先A', deleted: true }),
  ];
  const chains = groupChains(recs);
  const webChains = chains.map((c) => ({ chainId: c.chainId, latest: c.latest as never, versions: c.versions as never }));
  const web = applyFilters(webChains, { ...emptyCriteria, dateFrom: '2026-08-01', dateTo: '2026-08-31' }).map((c) => c.chainId);
  expect(searchChains(chains, { dateFrom: '2026-08-01', dateTo: '2026-08-31' }).map((c) => c.chainId)).toEqual(web);
  expect(summarize(chains, 'month').map(({ key, total, count }) => ({ month: key, total, count }))).toEqual(monthlySummary(webChains));
});
