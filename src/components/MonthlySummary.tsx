import type { MonthlyBucket } from "../filters";

const yen = new Intl.NumberFormat("ja-JP");

export function MonthlySummary({ buckets }: { buckets: MonthlyBucket[] }) {
  if (buckets.length === 0) return null;
  const grandTotal = buckets.reduce((s, b) => s + b.total, 0);

  return (
    <div className="summary">
      <h3>月次集計</h3>
      <table className="summary-table">
        <thead>
          <tr>
            <th>月</th>
            <th className="num">件数</th>
            <th className="num">合計金額</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.month}>
              <td>{b.month}</td>
              <td className="num">{b.count}</td>
              <td className="num">¥{yen.format(b.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>合計</td>
            <td className="num">{buckets.reduce((s, b) => s + b.count, 0)}</td>
            <td className="num">¥{yen.format(grandTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
