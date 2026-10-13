/**
 * Asset Inventory & Exception List — every inspected asset or area with its
 * status: normal, exception (links to the anomaly log) or not inspected /
 * inaccessible (with the reason). Exceptions can be seeded from the anomalies.
 */

import {
  CLASSIFICATION_LABELS,
  INVENTORY_STATUS_LABELS,
  type InventoryEntry,
  type InventoryStatus,
  type ThermalReport,
} from '@/types/thermal';
import { inputCls, nextEntryId, smallBtnCls, type SectionProps } from '../types';

export function InventoryActions({ report, update, setNotice }: SectionProps<ThermalReport>) {
  const addRow = (status: InventoryStatus) =>
    update({
      inventory: [...report.inventory, { id: nextEntryId('inv'), tag: '', description: '', status, note: '' }],
    });

  const fromAnomalies = () => {
    // One row per anomaly id — skipping ids already in the inventory and
    // duplicates within the log itself
    const tagged = new Set(report.inventory.map((r) => r.tag.trim().toLowerCase()));
    const rows: InventoryEntry[] = [];
    for (const a of report.anomalies) {
      const key = a.refId.trim().toLowerCase();
      if (!key || tagged.has(key)) continue;
      tagged.add(key);
      rows.push({
        id: nextEntryId('inv'),
        tag: a.refId.trim(),
        description: a.location,
        status: 'exception',
        note: `${CLASSIFICATION_LABELS[a.classification] ?? a.classification}, ${a.severity} severity`,
      });
    }
    if (rows.length === 0) {
      setNotice('Every anomaly already has an inventory row (matched by its ID).');
      return;
    }
    update({ inventory: [...report.inventory, ...rows] });
    setNotice(`Added ${rows.length} exception row(s) from the anomaly log.`);
  };

  return (
    <div className="flex gap-1.5">
      <button onClick={() => addRow('normal')} className={smallBtnCls}>
        + Add asset
      </button>
      <button
        onClick={() => addRow('not_inspected')}
        className={smallBtnCls}
        title="An asset or area that could not be inspected — give the reason in the note"
      >
        + Not inspected
      </button>
      <button
        onClick={fromAnomalies}
        disabled={report.anomalies.length === 0}
        className="px-2 py-1 rounded bg-drone-primary/80 hover:bg-drone-primary text-white text-[11px] disabled:opacity-40"
        title="One exception row per anomaly in the log"
      >
        ⚡ Exceptions from anomalies
      </button>
    </div>
  );
}

export function InventorySection({ report, update }: SectionProps<ThermalReport>) {
  const updateRow = (id: string, patch: Partial<InventoryEntry>) =>
    update({ inventory: report.inventory.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  return (
    <div className="space-y-1.5">
      {report.inventory.length === 0 && (
        <p className="text-[11px] text-gray-500">
          List the assets and areas covered by the survey with their status. Rows marked{' '}
          <em>Exception</em> form the exception list; rows marked <em>Not inspected</em> become the
          list of uninspected or inaccessible items in the report.
        </p>
      )}
      {report.inventory.length > 0 && (
        <div className="grid grid-cols-[7rem_1fr_11rem_1fr_1.5rem] gap-1.5 text-[10px] text-gray-400 px-0.5">
          <span>Asset / tag</span>
          <span>Description</span>
          <span>Status</span>
          <span>Note / anomaly IDs / reason</span>
          <span />
        </div>
      )}
      {report.inventory.map((r) => (
        <div key={r.id} className="grid grid-cols-[7rem_1fr_11rem_1fr_1.5rem] gap-1.5 items-center">
          <input
            className={`${inputCls} font-mono`}
            value={r.tag}
            onChange={(e) => updateRow(r.id, { tag: e.target.value })}
            placeholder="MDP-1"
          />
          <input
            className={inputCls}
            value={r.description}
            onChange={(e) => updateRow(r.id, { description: e.target.value })}
            placeholder="Main distribution panel, basement"
          />
          <select
            className={inputCls}
            value={r.status}
            onChange={(e) => updateRow(r.id, { status: e.target.value as InventoryStatus })}
          >
            {(Object.keys(INVENTORY_STATUS_LABELS) as InventoryStatus[]).map((k) => (
              <option key={k} value={k}>
                {INVENTORY_STATUS_LABELS[k]}
              </option>
            ))}
          </select>
          <input
            className={inputCls}
            value={r.note}
            onChange={(e) => updateRow(r.id, { note: e.target.value })}
            placeholder={r.status === 'not_inspected' ? 'Reason (locked, energised, no access…)' : 'A-01, A-02'}
          />
          <button
            onClick={() => update({ inventory: report.inventory.filter((x) => x.id !== r.id) })}
            className="text-gray-500 hover:text-red-400 text-xs"
            title="Remove row"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
