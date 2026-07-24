/**
 * ReportBuilder — modal for composing thermal inspection reports.
 *
 * Sections: Header Data · Summary · Thermal Imaging Log (side-by-side
 * visual/IR + LRF data) · Thermal Anomaly Log · Action Plan · Orthomosaic
 * link. Reports persist to the profile database and export as PDF or RTF.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import * as thermalApi from '@/lib/thermalApi';
import { buildReportPdf, buildReportRtf, saveReportFile, type ReportImages } from '@/lib/thermalReport';
import {
  CLASSIFICATION_LABELS,
  EMPTY_REPORT,
  type ReportAnomalyEntry,
  type ReportImageEntry,
  type Severity,
  type ThermalReport,
  type ThermalReportMeta,
} from '@/types/thermal';

interface Props {
  onClose: () => void;
  exportComposedImage: React.MutableRefObject<(() => Promise<string | null>) | null>;
}

let entryCounter = 0;
function nextEntryId(): string {
  entryCounter += 1;
  return `re_${Date.now().toString(36)}_${entryCounter}`;
}

const inputCls =
  'w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-drone-primary';
const labelCls = 'block text-[11px] font-medium text-gray-400 mb-1';

export function ReportBuilder({ onClose, exportComposedImage }: Props) {
  const { assets, selectedAssetId, anomalies, analysis, annotations } = useThermalStore();

  const [report, setReport] = useState<ThermalReport>({ ...EMPTY_REPORT });
  const [reportName, setReportName] = useState('Inspection Report');
  const [reportId, setReportId] = useState<number | null>(null);
  const [savedReports, setSavedReports] = useState<ThermalReportMeta[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const imageAssets = useMemo(() => assets.filter((a) => a.assetType === 'image'), [assets]);
  const selectedAsset = assets.find((a) => a.id === selectedAssetId) ?? null;

  const refreshSavedReports = useCallback(async () => {
    try {
      setSavedReports(await thermalApi.listThermalReports());
    } catch {
      // list is non-critical
    }
  }, []);

  useEffect(() => {
    refreshSavedReports();
    // Pre-fill inspection date on fresh reports
    setReport((r) =>
      r.inspectionDate ? r : { ...r, inspectionDate: new Date().toISOString().slice(0, 10) },
    );
  }, [refreshSavedReports]);

  const update = <K extends keyof ThermalReport>(key: K, value: ThermalReport[K]) =>
    setReport((r) => ({ ...r, [key]: value }));

  // ---- Imaging log ----
  const addImagingEntry = () => {
    const entry: ReportImageEntry = {
      id: nextEntryId(),
      thermalAssetId: selectedAsset?.isRadiometric ? selectedAsset.id : null,
      visualAssetId: null,
      lrfData: '',
      caption: '',
    };
    update('imagingLog', [...report.imagingLog, entry]);
  };

  const updateImagingEntry = (id: string, patch: Partial<ReportImageEntry>) =>
    update(
      'imagingLog',
      report.imagingLog.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    );

  // ---- Anomalies ----
  const importDetectedAnomalies = () => {
    if (!anomalies || !selectedAsset) return;
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
      classification: r.classification,
      finding: `${r.kind === 'hot' ? 'Hot' : 'Cold'} region (${r.areaPx.toLocaleString()} px) with mean ${r.tMean.toFixed(1)} °C, ${
        r.deltaT > 0 ? '+' : ''
      }${r.deltaT.toFixed(1)} °C vs. baseline.`,
      recommendation: '',
    }));
    update('anomalies', [...report.anomalies, ...entries]);
    setNotice(`Imported ${entries.length} detected anomalies.`);
  };

  const addManualAnomaly = () => {
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
    update('anomalies', [...report.anomalies, entry]);
  };

  const updateAnomaly = (id: string, patch: Partial<ReportAnomalyEntry>) =>
    update(
      'anomalies',
      report.anomalies.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    );

  // ---- Persistence ----
  const handleSave = async () => {
    setBusy('save');
    try {
      const id = await thermalApi.saveThermalReport(reportId, reportName, JSON.stringify(report));
      setReportId(id);
      await refreshSavedReports();
      setNotice('Report saved.');
    } catch (e) {
      setNotice(`Save failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const handleLoad = async (meta: ThermalReportMeta) => {
    setBusy('load');
    try {
      const json = await thermalApi.getThermalReport(meta.id);
      const parsed = JSON.parse(json) as ThermalReport;
      setReport({ ...EMPTY_REPORT, ...parsed });
      setReportName(meta.name);
      setReportId(meta.id);
    } catch (e) {
      setNotice(`Load failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteSaved = async (meta: ThermalReportMeta) => {
    if (!window.confirm(`Delete saved report "${meta.name}"?`)) return;
    try {
      await thermalApi.deleteThermalReport(meta.id);
      if (reportId === meta.id) setReportId(null);
      await refreshSavedReports();
    } catch (e) {
      setNotice(`Delete failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  // ---- Export ----
  const assetToDataUrl = useCallback(
    async (assetId: number | null): Promise<string | null> => {
      if (assetId == null) return null;
      const asset = assets.find((a) => a.id === assetId);
      if (!asset || asset.assetType !== 'image') return null;
      // Use the live annotated/palette-rendered view for the selected asset
      if (assetId === selectedAssetId && exportComposedImage.current && (annotations.length > 0 || asset.isRadiometric)) {
        try {
          const composed = await exportComposedImage.current();
          if (composed) return composed;
        } catch {
          // fall through to raw file
        }
      }
      try {
        const buf = await thermalApi.readThermalAssetFile(assetId);
        const ext = asset.fileName.toLowerCase().split('.').pop();
        const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
        const bytes = new Uint8Array(buf);
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        return `data:${mime};base64,${btoa(bin)}`;
      } catch {
        return null;
      }
    },
    [assets, selectedAssetId, exportComposedImage, annotations],
  );

  const collectImages = useCallback(async (): Promise<ReportImages> => {
    const images: ReportImages = {};
    for (const entry of report.imagingLog) {
      images[entry.id] = {
        thermal: await assetToDataUrl(entry.thermalAssetId),
        visual: await assetToDataUrl(entry.visualAssetId),
      };
    }
    return images;
  }, [report.imagingLog, assetToDataUrl]);

  const safeName = () =>
    (reportName || 'thermal-report').replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '_');

  const handleExportPdf = async () => {
    setBusy('pdf');
    try {
      const images = await collectImages();
      const pdf = await buildReportPdf(report, images);
      const ok = await saveReportFile(`${safeName()}.pdf`, pdf, 'PDF Report', 'pdf');
      if (ok) setNotice('PDF exported.');
    } catch (e) {
      setNotice(`PDF export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const handleExportRtf = async () => {
    setBusy('rtf');
    try {
      const images = await collectImages();
      const rtf = buildReportRtf(report, images);
      const ok = await saveReportFile(`${safeName()}.rtf`, rtf, 'RTF Report', 'rtf');
      if (ok) setNotice('RTF exported.');
    } catch (e) {
      setNotice(`RTF export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const assetOption = (a: { id: number; fileName: string }) => (
    <option key={a.id} value={a.id}>
      {a.fileName}
    </option>
  );

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl max-h-[92vh] bg-drone-secondary border border-gray-700 rounded-xl flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            📄 Thermal Inspection Report
          </h2>
          <div className="flex items-center gap-2">
            <input
              value={reportName}
              onChange={(e) => setReportName(e.target.value)}
              className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white w-48"
              placeholder="Report name"
            />
            <button
              onClick={handleSave}
              disabled={busy != null}
              className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium disabled:opacity-50"
            >
              {busy === 'save' ? 'Saving…' : reportId ? 'Save' : 'Save as new'}
            </button>
            <button
              onClick={handleExportPdf}
              disabled={busy != null}
              className="px-3 py-1.5 rounded bg-drone-primary hover:bg-drone-primary/80 text-white text-xs font-medium disabled:opacity-50"
            >
              {busy === 'pdf' ? 'Exporting…' : 'Export PDF'}
            </button>
            <button
              onClick={handleExportRtf}
              disabled={busy != null}
              className="px-3 py-1.5 rounded bg-drone-primary/70 hover:bg-drone-primary text-white text-xs font-medium disabled:opacity-50"
            >
              {busy === 'rtf' ? 'Exporting…' : 'Export RTF'}
            </button>
            <button onClick={onClose} className="ml-1 text-gray-400 hover:text-white px-2 py-1">
              ✕
            </button>
          </div>
        </div>

        {notice && (
          <div className="px-4 py-1.5 bg-sky-500/10 border-b border-sky-500/30 text-xs text-sky-300 flex justify-between">
            {notice}
            <button onClick={() => setNotice(null)} className="hover:text-white">✕</button>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
          {/* Saved reports */}
          {savedReports.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-300 mb-2">Saved reports</h3>
              <div className="flex flex-wrap gap-1.5">
                {savedReports.map((m) => (
                  <span
                    key={m.id}
                    className={`group inline-flex items-center gap-1 px-2 py-1 rounded border text-[11px] cursor-pointer ${
                      m.id === reportId
                        ? 'border-drone-primary text-white bg-drone-primary/15'
                        : 'border-gray-700 text-gray-300 hover:text-white'
                    }`}
                    onClick={() => handleLoad(m)}
                    title={m.updatedAt ?? ''}
                  >
                    {m.name}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteSaved(m);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400"
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <button
                  onClick={() => {
                    setReport({ ...EMPTY_REPORT, inspectionDate: new Date().toISOString().slice(0, 10) });
                    setReportId(null);
                    setReportName('Inspection Report');
                  }}
                  className="px-2 py-1 rounded border border-dashed border-gray-600 text-[11px] text-gray-400 hover:text-white"
                >
                  + New blank
                </button>
              </div>
            </section>
          )}

          {/* 1. Header data */}
          <section>
            <h3 className="text-xs font-semibold text-drone-primary uppercase tracking-wide mb-2">
              1 · Header Data
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className={labelCls}>Property address</label>
                <input
                  className={inputCls}
                  value={report.propertyAddress}
                  onChange={(e) => update('propertyAddress', e.target.value)}
                  placeholder="123 Main St, Springfield"
                />
              </div>
              <div>
                <label className={labelCls}>Inspection date</label>
                <input
                  type="date"
                  className={inputCls}
                  value={report.inspectionDate}
                  onChange={(e) => update('inspectionDate', e.target.value)}
                />
              </div>
              <div>
                <label className={labelCls}>Inspector name</label>
                <input
                  className={inputCls}
                  value={report.inspectorName}
                  onChange={(e) => update('inspectorName', e.target.value)}
                />
              </div>
              <div className="col-span-2">
                <label className={labelCls}>Weather conditions</label>
                <input
                  className={inputCls}
                  value={report.weatherConditions}
                  onChange={(e) => update('weatherConditions', e.target.value)}
                  placeholder="Overcast, 8 °C, wind 3 m/s NW, no precipitation last 24 h"
                />
              </div>
              <div className="col-span-2">
                <label className={labelCls}>Summary</label>
                <textarea
                  className={`${inputCls} min-h-[64px]`}
                  value={report.summary}
                  onChange={(e) => update('summary', e.target.value)}
                  placeholder="Scope, methodology and overall condition summary…"
                />
              </div>
            </div>
          </section>

          {/* 2. Imaging log */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-drone-primary uppercase tracking-wide">
                2 · Thermal Imaging Log / Comparative Matrix
              </h3>
              <button
                onClick={addImagingEntry}
                className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-white text-[11px]"
              >
                + Add imaging pair
              </button>
            </div>
            {report.imagingLog.length === 0 && (
              <p className="text-[11px] text-gray-500">
                Add side-by-side visual + infrared pairs (walls, windows, doors, roof). The
                currently selected asset's annotated view is used automatically on export.
              </p>
            )}
            <div className="space-y-2">
              {report.imagingLog.map((entry, i) => (
                <div key={entry.id} className="p-2.5 rounded-lg bg-gray-800/50 border border-gray-700">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-semibold text-gray-300">Pair {i + 1}</span>
                    <button
                      onClick={() =>
                        update('imagingLog', report.imagingLog.filter((e) => e.id !== entry.id))
                      }
                      className="text-gray-500 hover:text-red-400 text-xs"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>Visual (RGB) image</label>
                      <select
                        className={inputCls}
                        value={entry.visualAssetId ?? ''}
                        onChange={(e) =>
                          updateImagingEntry(entry.id, {
                            visualAssetId: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                      >
                        <option value="">— none —</option>
                        {imageAssets.map(assetOption)}
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Thermal (IR) image</label>
                      <select
                        className={inputCls}
                        value={entry.thermalAssetId ?? ''}
                        onChange={(e) =>
                          updateImagingEntry(entry.id, {
                            thermalAssetId: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                      >
                        <option value="">— none —</option>
                        {imageAssets.map(assetOption)}
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Caption / location</label>
                      <input
                        className={inputCls}
                        value={entry.caption}
                        onChange={(e) => updateImagingEntry(entry.id, { caption: e.target.value })}
                        placeholder="North wall, master bedroom window"
                      />
                    </div>
                    <div>
                      <label className={labelCls}>LRF / range data</label>
                      <input
                        className={inputCls}
                        value={entry.lrfData}
                        onChange={(e) => updateImagingEntry(entry.id, { lrfData: e.target.value })}
                        placeholder="Distance 24.3 m · target 41.1103, -85.2110"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 3. Anomaly log */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-drone-primary uppercase tracking-wide">
                3 · Anomalies & Findings
              </h3>
              <div className="flex gap-1.5">
                <button
                  onClick={importDetectedAnomalies}
                  disabled={!anomalies || anomalies.regions.length === 0}
                  className="px-2 py-1 rounded bg-drone-primary/80 hover:bg-drone-primary text-white text-[11px] disabled:opacity-40"
                  title={
                    anomalies
                      ? `Import ${anomalies.regions.length} detected anomalies`
                      : 'Run AI analysis first'
                  }
                >
                  ⚡ Import detected ({anomalies?.regions.length ?? 0})
                </button>
                <button
                  onClick={addManualAnomaly}
                  className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-white text-[11px]"
                >
                  + Manual entry
                </button>
              </div>
            </div>
            <div className="space-y-2">
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
                      onClick={() =>
                        update('anomalies', report.anomalies.filter((x) => x.id !== a.id))
                      }
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
                      <NumField
                        label="Latitude"
                        value={a.gpsLat}
                        step={0.000001}
                        onChange={(v) => updateAnomaly(a.id, { gpsLat: v })}
                      />
                      <NumField
                        label="Longitude"
                        value={a.gpsLon}
                        step={0.000001}
                        onChange={(v) => updateAnomaly(a.id, { gpsLon: v })}
                      />
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
          </section>

          {/* 4. Action plan */}
          <section>
            <h3 className="text-xs font-semibold text-drone-primary uppercase tracking-wide mb-2">
              4 · Action Plan & Repair Prioritization
            </h3>
            <textarea
              className={`${inputCls} min-h-[80px]`}
              value={report.actionPlan}
              onChange={(e) => update('actionPlan', e.target.value)}
              placeholder={'1. (High) Repair active moisture intrusion at A-01 …\n2. (Medium) Re-insulate void at A-02 …\n3. Energy-saving upgrades: …'}
            />
            <div className="mt-2">
              <label className={labelCls}>Orthomosaic map link (e.g. DJI Terra output)</label>
              <input
                className={inputCls}
                value={report.orthomosaicLink}
                onChange={(e) => update('orthomosaicLink', e.target.value)}
                placeholder="https://…/stitched-thermal-map"
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  step = 0.1,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <input
        type="number"
        step={step}
        className={inputCls}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    </div>
  );
}
