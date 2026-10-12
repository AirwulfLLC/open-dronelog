/**
 * Findings & Observations for photogrammetry surveys. A finding is a graded
 * issue (category, severity, recommendation); an observation is a neutral
 * note on what the imagery showed. Both can point at the figure documenting
 * them.
 */

import { useThermalStore } from '@/stores/thermalStore';
import { usePhotogrammetryStore } from '@/stores/photogrammetryStore';
import {
  PHOTO_FINDING_CATEGORIES,
  type PhotogrammetryFinding,
  type PhotogrammetryObservation,
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
  const addObservation = () => {
    const observation: PhotogrammetryObservation = {
      id: nextEntryId('po'),
      refId: `O-${String(report.observations.length + 1).padStart(2, '0')}`,
      figureId: null,
      location: '',
      text: '',
    };
    update({ observations: [...report.observations, observation] });
  };
  return (
    <div className="flex gap-1.5">
      <button onClick={addFinding} className={smallBtnCls} title="A graded issue with a recommendation">
        + Add finding
      </button>
      <button onClick={addObservation} className={smallBtnCls} title="A neutral note on what the imagery showed">
        + Add observation
      </button>
    </div>
  );
}

export function FindingsSection({ report, update }: SectionProps<PhotogrammetryReport>) {
  // Figures come from the live queue so the dropdown matches the export order
  const queue = usePhotogrammetryStore((s) => s.queue);
  const assets = useThermalStore((s) => s.assets);

  const updateFinding = (id: string, patch: Partial<PhotogrammetryFinding>) =>
    update({ findings: report.findings.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
  const updateObservation = (id: string, patch: Partial<PhotogrammetryObservation>) =>
    update({ observations: report.observations.map((o) => (o.id === id ? { ...o, ...patch } : o)) });

  const figureLabel = (i: number, caption: string, assetId: number) => {
    const name = assets.find((a) => a.id === assetId)?.fileName ?? 'missing asset';
    return `Figure ${i + 1} — ${caption.trim() || name}`;
  };

  const figureOptions = (
    <>
      <option value="">— none —</option>
      {queue.map((entry, i) => (
        <option key={entry.id} value={entry.id}>
          {figureLabel(i, entry.caption, entry.assetId)}
        </option>
      ))}
    </>
  );

  return (
    <div className="space-y-2">
      {report.findings.length === 0 && report.observations.length === 0 && (
        <p className="text-[11px] text-gray-500">
          Record what the imagery shows. Add a <b>finding</b> for a graded issue —
          structural defect, surface deterioration, vegetation encroachment, erosion,
          obstruction — with a recommendation, or an <b>observation</b> for a neutral
          note on the condition seen. Link each to the figure that documents it.
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
                {figureOptions}
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

      {report.observations.length > 0 && (
        <div className="pt-1">
          <div className="text-[11px] font-semibold text-gray-300 mb-1.5">Observations</div>
          <div className="space-y-2">
            {report.observations.map((o) => (
              <div key={o.id} className="p-2.5 rounded-lg bg-gray-800/50 border border-gray-700">
                <div className="flex items-center gap-2 mb-2">
                  <input
                    className="w-16 px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white font-mono"
                    value={o.refId}
                    onChange={(e) => updateObservation(o.id, { refId: e.target.value })}
                  />
                  <select
                    className="flex-1 px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white"
                    value={o.figureId ?? ''}
                    onChange={(e) => updateObservation(o.id, { figureId: e.target.value || null })}
                    title="Documented in figure"
                  >
                    {figureOptions}
                  </select>
                  <button
                    onClick={() => update({ observations: report.observations.filter((x) => x.id !== o.id) })}
                    className="text-gray-500 hover:text-red-400 text-xs"
                  >
                    ✕
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className={labelCls}>Location</label>
                    <input
                      className={inputCls}
                      value={o.location}
                      onChange={(e) => updateObservation(o.id, { location: e.target.value })}
                      placeholder="South slope, bay 3"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className={labelCls}>Observation</label>
                    <textarea
                      className={`${inputCls} min-h-[48px]`}
                      value={o.text}
                      onChange={(e) => updateObservation(o.id, { text: e.target.value })}
                      placeholder="Membrane appears recently replaced; no ponding visible at time of survey"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
