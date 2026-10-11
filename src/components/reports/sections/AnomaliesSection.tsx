/**
 * Thermal Anomaly Log — detected anomalies (imported from the analysis panel)
 * or manual entries: ID, geotag, temperatures, severity, classification,
 * finding and recommendation.
 */

import { useThermalStore } from '@/stores/thermalStore';
import {
  CLASSIFICATION_LABELS,
  type ReportAnomalyEntry,
  type Severity,
  type ThermalReport,
} from '@/types/thermal';
import { NumField, inputCls, labelCls, nextEntryId, smallBtnCls, type SectionProps } from '../types';

export function AnomaliesActions({ report, update, setNotice }: SectionProps<ThermalReport>) {
  const { assets, selectedAssetId, anomalies, analysis, valueSuffix } = useThermalStore();
  const selectedAsset = assets.find((a) => a.id === selectedAssetId) ?? null;

  const importDetected = () => {
    if (!anomalies || !selectedAsset) return;
    const isIndex = valueSuffix === '';
    const unit = isIndex ? '' : ' °C';
    const dp = isIndex ? 3 : 1;
    const existing = report.anomalies.length;
    const entries: ReportAnomalyEntry[] = anomalies.regions.map((r, i) => ({
      id: nextEntryId(),
      refId: `A-${String(existing + i + 1).padStart(2, '0')}`,
      assetId: selectedAsset.id,
      location: `${selectedAsset.fileName} @ px (${Math.round(r.centroid[0])}, ${Math.round(r.centroid[1])})`,
      gpsLat: selectedAsset.gpsLat,
      gpsLon: selectedAsset.gpsLon,
      tMax: r.tMax,
      tMin: r.tMin,
      baseline: anomalies.baseline,
      deltaT: r.deltaT,
      severity: r.severity,
      // Thermal defect classes don't apply to vegetation-index regions
      classification: isIndex ? 'other' : r.classification,
      finding: isIndex
        ? `${r.kind === 'hot' ? 'High' : 'Low'}-index region (${r.areaPx.toLocaleString()} px) with mean ${r.tMean.toFixed(dp)}, ${
            r.deltaT > 0 ? '+' : ''
          }${r.deltaT.toFixed(dp)} vs. scene baseline (vegetation index units).`
        : `${r.kind === 'hot' ? 'Hot' : 'Cold'} region (${r.areaPx.toLocaleString()} px) with mean ${r.tMean.toFixed(dp)}${unit}, ${
            r.deltaT > 0 ? '+' : ''
          }${r.deltaT.toFixed(dp)}${unit} vs. baseline.`,
      recommendation: '',
    }));
    update({ anomalies: [...report.anomalies, ...entries] });
    setNotice(`Imported ${entries.length} detected anomalies.`);
  };

  const addManual = () => {
    const entry: ReportAnomalyEntry = {
      id: nextEntryId(),
      refId: `A-${String(report.anomalies.length + 1).padStart(2, '0')}`,
      assetId: selectedAsset?.id ?? null,
      location: '',
      gpsLat: selectedAsset?.gpsLat ?? null,
      gpsLon: selectedAsset?.gpsLon ?? null,
      tMax: analysis?.stats.max ?? null,
      tMin: analysis?.stats.min ?? null,
      baseline: anomalies?.baseline ?? analysis?.stats.median ?? null,
      deltaT: null,
      severity: 'medium',
      classification: 'other',
      finding: '',
      recommendation: '',
    };
    update({ anomalies: [...report.anomalies, entry] });
  };

  return (
    <div className="flex gap-1.5">
      <button
        onClick={importDetected}
        disabled={!anomalies || anomalies.regions.length === 0}
        className="px-2 py-1 rounded bg-drone-primary/80 hover:bg-drone-primary text-white text-[11px] disabled:opacity-40"
        title={anomalies ? `Import ${anomalies.regions.length} detected anomalies` : 'Run AI analysis first'}
      >
        ⚡ Import detected ({anomalies?.regions.length ?? 0})
      </button>
      <button onClick={addManual} className={smallBtnCls}>
        + Manual entry
      </button>
    </div>
  );
}

export function AnomaliesSection({ report, update }: SectionProps<ThermalReport>) {
  const updateAnomaly = (id: string, patch: Partial<ReportAnomalyEntry>) =>
    update({ anomalies: report.anomalies.map((a) => (a.id === id ? { ...a, ...patch } : a)) });

  return (
    <div className="space-y-2">
      {report.anomalies.length === 0 && (
        <p className="text-[11px] text-gray-500">
          Import the anomalies detected on the selected asset, or add manual entries.
        </p>
      )}
      {report.anomalies.map((a) => (
        <div key={a.id} className="p-2.5 rounded-lg bg-gray-800/50 border border-gray-700">
          <div className="flex items-center gap-2 mb-2">
            <input
              className="w-16 px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white font-mono"
              value={a.refId}
              onChange={(e) => updateAnomaly(a.id, { refId: e.target.value })}
            />
            <select
              className="px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white"
              value={a.severity}
              onChange={(e) => updateAnomaly(a.id, { severity: e.target.value as Severity })}
            >
              <option value="low">Low severity</option>
              <option value="medium">Medium severity</option>
              <option value="high">High severity</option>
            </select>
            <select
              className="flex-1 px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white"
              value={a.classification}
              onChange={(e) => updateAnomaly(a.id, { classification: e.target.value })}
            >
              {Object.entries(CLASSIFICATION_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <button
              onClick={() => update({ anomalies: report.anomalies.filter((x) => x.id !== a.id) })}
              className="text-gray-500 hover:text-red-400 text-xs"
            >
              ✕
            </button>
          </div>
          <div className="grid grid-cols-4 gap-2 mb-2">
            <NumField label="T max (°C)" value={a.tMax} onChange={(v) => updateAnomaly(a.id, { tMax: v })} />
            <NumField label="T min (°C)" value={a.tMin} onChange={(v) => updateAnomaly(a.id, { tMin: v })} />
            <NumField label="Baseline (°C)" value={a.baseline} onChange={(v) => updateAnomaly(a.id, { baseline: v })} />
            <NumField label="ΔT (°C)" value={a.deltaT} onChange={(v) => updateAnomaly(a.id, { deltaT: v })} />
          </div>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <div>
              <label className={labelCls}>Location</label>
              <input
                className={inputCls}
                value={a.location}
                onChange={(e) => updateAnomaly(a.id, { location: e.target.value })}
                placeholder="SE corner, below window sill"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumField label="Latitude" value={a.gpsLat} step={0.000001} onChange={(v) => updateAnomaly(a.id, { gpsLat: v })} />
              <NumField label="Longitude" value={a.gpsLon} step={0.000001} onChange={(v) => updateAnomaly(a.id, { gpsLon: v })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Finding</label>
              <textarea
                className={`${inputCls} min-h-[48px]`}
                value={a.finding}
                onChange={(e) => updateAnomaly(a.id, { finding: e.target.value })}
              />
            </div>
            <div>
              <label className={labelCls}>Recommendation</label>
              <textarea
                className={`${inputCls} min-h-[48px]`}
                value={a.recommendation}
                onChange={(e) => updateAnomaly(a.id, { recommendation: e.target.value })}
                placeholder="Re-insulate cavity; verify with follow-up scan"
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
