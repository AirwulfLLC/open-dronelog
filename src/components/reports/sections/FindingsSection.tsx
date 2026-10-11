/**
 * Findings & Observations for photogrammetry surveys: numbered observations
 * with category, severity, location, optional link to a figure, and a
 * recommendation.
 */

import { useThermalStore } from '@/stores/thermalStore';
import { usePhotogrammetryStore } from '@/stores/photogrammetryStore';
import {
  PHOTO_FINDING_CATEGORIES,
  type PhotogrammetryFinding,
  type PhotogrammetryReport,
  type Severity,
} from '@/types/thermal';
import { inputCls, labelCls, nextEntryId, smallBtnCls, type SectionProps } from '../types';

export function FindingsActions({ report, update }: SectionProps<PhotogrammetryReport>) {
  const addFinding = () => {
    const finding: PhotogrammetryFinding = {
      id: nextEntryId('pf'),
      refId: `F-${String(report.findings.length + 1).padStart(2, '0')}`,
      figureId: null,
      location: '',
      category: 'other',
      severity: 'medium',
      observation: '',
      recommendation: '',
    };
    update({ findings: [...report.findings, finding] });
  };
  return (
    <button onClick={addFinding} className={smallBtnCls}>
      + Add finding
    </button>
  );
}

export function FindingsSection({ report, update }: SectionProps<PhotogrammetryReport>) {
  // Figures come from the live queue so the dropdown matches the export order
  const queue = usePhotogrammetryStore((s) => s.queue);
  const assets = useThermalStore((s) => s.assets);

  const updateFinding = (id: string, patch: Partial<PhotogrammetryFinding>) =>
    update({ findings: report.findings.map((f) => (f.id === id ? { ...f, ...patch } : f)) });

  const figureLabel = (i: number, caption: string, assetId: number) => {
    const name = assets.find((a) => a.id === assetId)?.fileName ?? 'missing asset';
    return `Figure ${i + 1} — ${caption.trim() || name}`;
  };

  return (
    <div className="space-y-2">
      {report.findings.length === 0 && (
        <p className="text-[11px] text-gray-500">
          Record what the imagery shows — structural defects, surface deterioration,
          vegetation encroachment, erosion, obstructions — and link each finding to the
          figure that documents it.
        </p>
      )}
      {report.findings.map((f) => (
        <div key={f.id} className="p-2.5 rounded-lg bg-gray-800/50 border border-gray-700">
          <div className="flex items-center gap-2 mb-2">
            <input
              className="w-16 px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white font-mono"
              value={f.refId}
              onChange={(e) => updateFinding(f.id, { refId: e.target.value })}
            />
            <select
              className="px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white"
              value={f.severity}
              onChange={(e) => updateFinding(f.id, { severity: e.target.value as Severity })}
            >
              <option value="low">Low severity</option>
              <option value="medium">Medium severity</option>
              <option value="high">High severity</option>
            </select>
            <select
              className="flex-1 px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white"
              value={f.category}
              onChange={(e) => updateFinding(f.id, { category: e.target.value })}
            >
              {Object.entries(PHOTO_FINDING_CATEGORIES).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <button
              onClick={() => update({ findings: report.findings.filter((x) => x.id !== f.id) })}
              className="text-gray-500 hover:text-red-400 text-xs"
            >
              ✕
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <div>
              <label className={labelCls}>Documented in figure</label>
              <select
                className={inputCls}
                value={f.figureId ?? ''}
                onChange={(e) => updateFinding(f.id, { figureId: e.target.value || null })}
              >
                <option value="">— none —</option>
                {queue.map((entry, i) => (
                  <option key={entry.id} value={entry.id}>
                    {figureLabel(i, entry.caption, entry.assetId)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Location</label>
              <input
                className={inputCls}
                value={f.location}
                onChange={(e) => updateFinding(f.id, { location: e.target.value })}
                placeholder="North elevation, parapet · 41.1103, -85.2110"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Observation</label>
              <textarea
                className={`${inputCls} min-h-[48px]`}
                value={f.observation}
                onChange={(e) => updateFinding(f.id, { observation: e.target.value })}
              />
            </div>
            <div>
              <label className={labelCls}>Recommendation</label>
              <textarea
                className={`${inputCls} min-h-[48px]`}
                value={f.recommendation}
                onChange={(e) => updateFinding(f.id, { recommendation: e.target.value })}
                placeholder="Schedule close-up inspection; monitor at next survey"
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
