import type { ReceiptChain } from "../useReceipts";

interface Props {
  chains: ReceiptChain[];
  onSelect: (chain: ReceiptChain) => void;
}

const yen = new Intl.NumberFormat("ja-JP");

export function ReceiptTable({ chains, onSelect }: Props) {
  if (chains.length === 0) {
    return <p className="muted empty">該当するレシートがありません。</p>;
  }

  return (
    <div className="table-wrap">
      <table className="receipts">
        <thead>
          <tr>
            <th>取引年月日</th>
            <th>取引先</th>
            <th className="num">金額</th>
            <th>科目</th>
            <th>状態</th>
            <th>版</th>
          </tr>
        </thead>
        <tbody>
          {chains.map((c) => {
            const r = c.latest;
            return (
              <tr key={c.chainId} onClick={() => onSelect(c)} className={r.deleted ? "deleted" : ""}>
                <td>{r.receiptDate}</td>
                <td>{r.vendor}</td>
                <td className="num">¥{yen.format(r.amount)}</td>
                <td>{r.category ?? "—"}</td>
                <td>
                  {r.deleted ? <span className="badge del">削除済</span> : <span className="badge">{r.status}</span>}
                </td>
                <td className="num">{c.versions.length > 1 ? `v${r.version}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
