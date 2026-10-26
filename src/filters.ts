import type { ReceiptChain } from "./useReceipts";

export interface FilterCriteria {
  vendor: string; // 部分一致
  dateFrom: string; // YYYY-MM-DD
  dateTo: string;
  amountMin: string; // 空文字は未指定
  amountMax: string;
  includeDeleted: boolean;
}

export const emptyCriteria: FilterCriteria = {
  vendor: "",
  dateFrom: "",
  dateTo: "",
  amountMin: "",
  amountMax: "",
  includeDeleted: false,
};

// 法定検索要件 (日付・金額・取引先の範囲指定 + 組合せ) をクライアント側で適用する。
export function applyFilters(chains: ReceiptChain[], c: FilterCriteria): ReceiptChain[] {
  const vendorQ = c.vendor.trim();
  const amountMin = c.amountMin === "" ? null : Number(c.amountMin);
  const amountMax = c.amountMax === "" ? null : Number(c.amountMax);

  return chains.filter(({ latest }) => {
    if (!c.includeDeleted && latest.deleted) return false;
    if (vendorQ && !latest.vendor.includes(vendorQ)) return false;
    if (c.dateFrom && latest.receiptDate < c.dateFrom) return false;
    if (c.dateTo && latest.receiptDate > c.dateTo) return false;
    if (amountMin !== null && latest.amount < amountMin) return false;
    if (amountMax !== null && latest.amount > amountMax) return false;
    return true;
  });
}

// 月次集計 (YYYY-MM -> 合計金額・件数)。削除済みは除外。
export interface MonthlyBucket {
  month: string;
  total: number;
  count: number;
}

export function monthlySummary(chains: ReceiptChain[]): MonthlyBucket[] {
  const map = new Map<string, MonthlyBucket>();
  for (const { latest } of chains) {
    if (latest.deleted) continue;
    const month = latest.receiptDate.slice(0, 7);
    const b = map.get(month) ?? { month, total: 0, count: 0 };
    b.total += latest.amount;
    b.count += 1;
    map.set(month, b);
  }
  return [...map.values()].sort((a, b) => b.month.localeCompare(a.month));
}

// 台帳 CSV (日付・取引先・金額・科目・按分・メモ・状態・証憑ID)。
export function toCsv(chains: ReceiptChain[]): string {
  const header = ["取引年月日", "取引先", "金額", "勘定科目", "事業按分%", "メモ", "状態", "削除", "証憑ID"];
  const rows = chains.map(({ latest }) => [
    latest.receiptDate,
    latest.vendor,
    latest.amount,
    latest.category ?? "",
    latest.businessRatio,
    latest.memo,
    latest.status,
    latest.deleted ? "削除済" : "",
    latest.chainId,
  ]);
  const escape = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  return [header, ...rows].map((r) => r.map(escape).join(",")).join("\r\n");
}

// 仕訳CSV（複式簿記・借方/貸方）。
//
// 簿記手段の選定 (Phase 4-1, 2026-07-08): スプレッドシート簿記（Google Sheets 等）を採用。
// 理由: 調査 (research-aoiro-65man-free-route) で GnuCash・スプレッドシート双方が
// 「無料かつ青色65万控除に適合」と確認済みで優劣なし。追加ソフト導入が不要で、
// 既存の Google Sheets 連携をそのまま使える方が運用コストが低いため後者を選んだ。
// e-Tax の確定申告書等作成コーナーは帳簿の作成手段を問わないため、この選択自体が
// 65万控除の要件（複式簿記＋期限内申告＋e-Tax）を損なうことはない。
//
// 仕訳ルール: 事業按分 (businessRatio) を乗じた金額を「借方=勘定科目」、
// 個人事業主が立替払いした前提で「貸方=事業主借」に計上する単純化ルール。
// 事業用口座から直接引落しの場合は貸方勘定科目を手動で「普通預金」等に置き換えること。
export function toJournalCsv(chains: ReceiptChain[]): string {
  const header = ["取引年月日", "借方勘定科目", "借方金額", "貸方勘定科目", "貸方金額", "摘要", "証憑ID"];
  const rows = chains
    .filter(({ latest }) => !latest.deleted)
    .map(({ latest }) => {
      const businessAmount = Math.round((latest.amount * latest.businessRatio) / 100);
      const memo = [latest.vendor, latest.memo].filter(Boolean).join(" ");
      return [
        latest.receiptDate,
        latest.category ?? "（科目未設定）",
        String(businessAmount),
        "事業主借",
        String(businessAmount),
        memo,
        latest.chainId,
      ];
    });
  const escape = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  return [header, ...rows].map((r) => r.map(escape).join(",")).join("\r\n");
}

export function downloadCsv(filename: string, csv: string): void {
  // Excel が UTF-8 を正しく認識するよう BOM を付与。
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
