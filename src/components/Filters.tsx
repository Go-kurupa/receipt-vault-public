import type { FilterCriteria } from "../filters";
import { emptyCriteria } from "../filters";

interface Props {
  value: FilterCriteria;
  onChange: (c: FilterCriteria) => void;
  resultCount: number;
  totalCount: number;
}

export function Filters({ value, onChange, resultCount, totalCount }: Props) {
  const set = (patch: Partial<FilterCriteria>) => onChange({ ...value, ...patch });

  return (
    <div className="filters">
      <div className="filter-row">
        <label>
          取引先
          <input
            type="text"
            placeholder="店名で絞り込み"
            value={value.vendor}
            onChange={(e) => set({ vendor: e.target.value })}
          />
        </label>
        <label>
          日付 (自)
          <input type="date" value={value.dateFrom} onChange={(e) => set({ dateFrom: e.target.value })} />
        </label>
        <label>
          日付 (至)
          <input type="date" value={value.dateTo} onChange={(e) => set({ dateTo: e.target.value })} />
        </label>
        <label>
          金額 (下限)
          <input
            type="number"
            placeholder="0"
            value={value.amountMin}
            onChange={(e) => set({ amountMin: e.target.value })}
          />
        </label>
        <label>
          金額 (上限)
          <input
            type="number"
            placeholder="上限なし"
            value={value.amountMax}
            onChange={(e) => set({ amountMax: e.target.value })}
          />
        </label>
      </div>
      <div className="filter-row filter-actions">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={value.includeDeleted}
            onChange={(e) => set({ includeDeleted: e.target.checked })}
          />
          削除済みも表示
        </label>
        <button className="ghost" onClick={() => onChange(emptyCriteria)}>
          条件クリア
        </button>
        <span className="muted small">
          {resultCount} / {totalCount} 件
        </span>
      </div>
    </div>
  );
}
