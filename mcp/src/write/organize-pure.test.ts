import { expect, test } from 'vitest';
import { SERVER_TIMESTAMP, buildReceiptDoc } from '../../../functions/src/versioning';
import { parseOrganizePatch, diffPatch, buildOrganizeVersion } from './organize-pure';
const latest = buildReceiptDoc({ kind: 'paper', receiptDate: '2026-10-01', receivedDate: '2026-10-01', amount: 100, vendor: '店', category: null, memo: null, project: null, businessRatio: 100, source: 'discord' }, { chainId: 'c1', storagePath: 'file', sha256: 'hash', mimeType: 'image/jpeg', resolutionOk: true });
test.each<[unknown, unknown]>([
  [{ category: ' 科目 ', project: ' 案件 ', memo: ' メモ ', journalNo: ' 123 ' }, { category: '科目', project: '案件', memo: 'メモ', journalNo: '123' }],
  [{ category: null, project: null, memo: null, journalNo: null }, { category: null, project: null, memo: null, journalNo: null }],
  [{ memo: '  ' }, { memo: '' }],
  ...[0, 50.5, 100].map(businessRatio => [{ businessRatio }, { businessRatio }] as [unknown, unknown]),
  ...['未記帳', '記帳済', '要確認'].map(status => [{ status }, { status }] as [unknown, unknown]),
  [{ category: 'a'.repeat(40), project: 'a'.repeat(40), memo: 'a'.repeat(500), journalNo: 'a'.repeat(50) }, { category: 'a'.repeat(40), project: 'a'.repeat(40), memo: 'a'.repeat(500), journalNo: 'a'.repeat(50) }],
])('accepts and normalizes %j', (raw, patch) => expect(parseOrganizePatch(raw)).toEqual({ ok: true, patch }));
test.each([null, [], 'x', {}, { amount: 100 }, { category: '' }, { category: ' ' }, { category: 'a'.repeat(41) }, { category: 5 }, { project: '' }, { project: 'a'.repeat(41) }, { memo: 'a'.repeat(501) }, { memo: false }, { journalNo: '' }, { journalNo: 'a'.repeat(51) }, { journalNo: '\n123' }, { journalNo: 'x\u007f' }, { businessRatio: NaN }, { businessRatio: Infinity }, { businessRatio: -1 }, { businessRatio: 101 }, { businessRatio: '50' }, { status: 'other' }, { status: null }, { memo: undefined }])('rejects %j', raw => expect(parseOrganizePatch(raw).ok).toBe(false));
test('names unknown fields', () => expect(parseOrganizePatch({ amount: 100 })).toEqual({ ok: false, error: expect.stringContaining('amount') }));
test('diff excludes unchanged values and preserves null and zero', () => {
  expect(diffPatch(latest, { status: '未記帳', memo: null, businessRatio: 0 })).toEqual([{ field: 'businessRatio', before: 100, after: 0 }]);
});
test('keeps original source, timestamp sentinel and existing fields only', () => {
  const version = buildOrganizeVersion({ ...latest, docId: 'd1' }, { status: '記帳済' });
  expect(version).toMatchObject({ source: 'discord', version: 2, chainId: 'c1', prevVersionId: 'd1', registeredAt: SERVER_TIMESTAMP, status: '記帳済' });
  expect(Object.keys(version).sort()).toEqual(Object.keys(latest).sort());
});
