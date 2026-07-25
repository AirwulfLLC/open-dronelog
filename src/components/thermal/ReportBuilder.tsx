/**
 * ReportBuilder — modal for composing thermal inspection reports.
 *
 * Sections: Header Data · Summary · Thermal Imaging Log (side-by-side
 * visual/IR + LRF data) · Thermal Anomaly Log · Action Plan · Orthomosaic
 * link. Reports persist to the profile database and export as PDF or RTF.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useThermalStore } from '@/stores/thermalStore';
import { useFlightStore } from '@/stores/flightStore';
import * as thermalApi from '@/lib/thermalApi';
import {
  buildReportPdf,
  buildReportRtf,
  saveReportFile,
  type ReportExtras,
  type ReportImages,
} from '@/lib/thermalReport';
import {
  CLASSIFICATION_LABELS,
  EMPTY_REPORT,
  METASHAPE_KIND_LABELS,
  hasDisplayableImage,
  parseMetashapeMeta,
  type FlightSnapshot,
  type ReportAnomalyEntry,
  type ReportImageEntry,
  type Severity,
  type ThermalReport,
  type ThermalReportMeta,
} from '@/types/thermal';
import type { Flight } from '@/types';

function flightToSnapshot(f: Flight): FlightSnapshot {
  return {
    id: f.id,
    displayName: f.displayName || f.fileName,
    startTime: f.startTime,
    droneModel: f.droneModel,
    aircraftName: f.aircraftName,
    durationSecs: f.durationSecs,
    totalDistance: f.totalDistance,
    maxAltitude: f.maxAltitude,
    maxSpeed: f.maxSpeed,
    homeLat: f.homeLat ?? null,
    homeLon: f.homeLon ?? null,
    photoCount: f.photoCount,
  };
}

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
  const { assets, selectedAssetId, anomalies, analysis, annotations, valueSuffix } =
    useThermalStore();
  const { flights } = useFlightStore();

  const [report, setReport] = useState<ThermalReport>({ ...EMPTY_REPORT });
  const [reportName, setReportName] = useState('Inspection Report');
  const [reportId, setReportId] = useState<number | null>(null);
  const [savedReports, setSavedReports] = useState<ThermalReportMeta[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Only displayable images can be embedded (GeoTIFFs need a working preview)
  const imageAssets = useMemo(() => assets.filter(hasDisplayableImage), [assets]);
  const orthoAssets = useMemo(
    () => assets.filter((a) => a.source === 'metashape' && hasDisplayableImage(a)),
    [assets],
  );
  const selectedAsset = assets.find((a) => a.id === selectedAssetId) ?? null;
  const orthoAsset = assets.find((a) => a.id === report.orthoAssetId) ?? null;

  const toggleFlight = (f: Flight) => {
    const linked = report.linkedFlights.some((s) => s.id === f.id);
    update(
      'linkedFlights',
      linked
        ? report.linkedFlights.filter((s) => s.id !== f.id)
        : [...report.linkedFlights, flightToSnapshot(f)],
    );
  };

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
      if (!hasDisplayableImage(asset)) return null;
      try {
        // The preview endpoint serves GeoTIFF orthomosaics as their PNG
        // preview and everything else as the original file.
        const buf = await thermalApi.readThermalAssetPreview(assetId);
        const ext = asset.fileName.toLowerCase().split('.').pop();
        const mime =
          asset.source === 'metashape' || ext === 'png' ? 'image/png' : 'image/jpeg';
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

  const collectExtras = useCallback(async (): Promise<ReportExtras> => {
    const extras: ReportExtras = {};
    if (report.orthoAssetId != null && orthoAsset) {
      try {
        // Orthomosaics render via their PNG preview
        const buf = await thermalApi.readThermalAssetPreview(report.orthoAssetId);
        const bytes = new Uint8Array(buf);
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        extras.orthoDataUrl = `data:image/png;base64,${btoa(bin)}`;
        const m = parseMetashapeMeta(orthoAsset);
        if (m?.width && m?.height) {
          // height/width — used to embed at the true aspect ratio
          extras.orthoAspect = m.height / m.width;
        }
        extras.orthoLabel = [
          orthoAsset.fileName,
          m?.width ? `${m.width}×${m.height} px` : null,
          m?.crs ?? null,
        ]
          .filter(Boolean)
          .join(' · ');
      } catch {
        // ortho embed is best-effort
      }
    }
    return extras;
  }, [report.orthoAssetId, orthoAsset]);

  /** All asset ids referenced by this report (for bundle export). */
  const referencedAssetIds = useCallback((): number[] => {
    const ids = new Set<number>();
    for (const e of report.imagingLog) {
      if (e.thermalAssetId != null) ids.add(e.thermalAssetId);
      if (e.visualAssetId != null) ids.add(e.visualAssetId);
    }
    for (const a of report.anomalies) {
      if (a.assetId != null) ids.add(a.assetId);
    }
    if (report.orthoAssetId != null) ids.add(report.orthoAssetId);
    // Metashape documents (reports, camera files, point clouds) always travel
    // with the inspection — they are part of its evidence base.
    for (const a of assets) {
      if (a.source === 'metashape') ids.add(a.id);
    }
    return [...ids];
  }, [report, assets]);

  const handleExportBundle = async () => {
    setBusy('bundle');
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const dest = await save({
        defaultPath: `${safeName()}.odlbundle`,
        filters: [{ name: 'Inspection Bundle', extensions: ['odlbundle'] }],
      });
      if (!dest) {
        setBusy(null);
        return;
      }
      await thermalApi.exportThermalBundle({
        destPath: dest,
        name: reportName || 'Inspection',
        reportJson: JSON.stringify(report),
        assetIds: referencedAssetIds(),
        flightIds: report.linkedFlights.map((f) => f.id),
      });
      setNotice('Inspection bundle exported.');
    } catch (e) {
      setNotice(`Bundle export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const safeName = () =>
    (reportName || 'thermal-report').replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '_');

  const handleExportPdf = async () => {
    setBusy('pdf');
    try {
      const images = await collectImages();
      const extras = await collectExtras();
      const pdf = await buildReportPdf(report, images, extras);
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
      const extras = await collectExtras();
      const rtf = buildReportRtf(report, images, extras);
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
            <button
              onClick={handleExportBundle}
              disabled={busy != null}
              title="Save the complete inspection — report, assets, annotations, networks and linked flight data — as a single portable file"
              className="px-3 py-1.5 rounded bg-emerald-600/80 hover:bg-emerald-600 text-white text-xs font-medium disabled:opacity-50"
            >
              {busy === 'bundle' ? 'Exporting…' : 'Export Bundle'}
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

          {/* Flight data (DJI logs linked to this inspection) */}
          <section>
            <h3 className="text-xs font-semibold text-drone-primary uppercase tracking-wide mb-2">
              2 · Flight Data (DJI)
            </h3>
            {flights.length === 0 ? (
              <p className="text-[11px] text-gray-500">
                No flights in the log yet — import DJI flight logs from the Individual/Overview
                views, then link them here.
              </p>
            ) : (
              <>
                <p className="text-[11px] text-gray-500 mb-2">
                  Link the flights that produced this inspection's imagery. Their
                  operations data is embedded in the report and their full telemetry is
                  included in exported inspection bundles.
                </p>
                <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-700 divide-y divide-gray-800">
                  {flights.map((f) => {
                    const linked = report.linkedFlights.some((s) => s.id === f.id);
                    return (
                      <label
                        key={f.id}
                        className={`flex items-center gap-2 px-2.5 py-1.5 text-[11px] cursor-pointer ${
                          linked ? 'bg-drone-primary/10 text-white' : 'text-gray-400 hover:bg-gray-800/60'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={linked}
                          onChange={() => toggleFlight(f)}
                          className="accent-sky-500"
                        />
                        <span className="flex-1 truncate">{f.displayName || f.fileName}</span>
                        <span className="text-gray-500 whitespace-nowrap">
                          {f.startTime ? f.startTime.slice(0, 10) : ''}
                          {f.droneModel ? ` · ${f.droneModel}` : ''}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {report.linkedFlights.length > 0 && (
                  <p className="mt-1.5 text-[10px] text-gray-500">
                    {report.linkedFlights.length} flight(s) linked
                    {report.linkedFlights.some((s) => !flights.some((f) => f.id === s.id)) &&
                      ' (some linked flights are no longer in the log — their snapshots remain in the report)'}
                  </p>
                )}
              </>
            )}
          </section>

          {/* Metashape orthomosaic */}
          <section>
            <h3 className="text-xs font-semibold text-drone-primary uppercase tracking-wide mb-2">
              3 · Orthomosaic (Agisoft Metashape)
            </h3>
            {orthoAssets.length === 0 ? (
              <p className="text-[11px] text-gray-500">
                Import a Metashape orthomosaic (GeoTIFF) into the asset library to embed it
                here. Processing reports, camera files and point clouds can also be imported
                — they travel with exported inspection bundles.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Embedded orthomosaic image</label>
                  <select
                    className={inputCls}
                    value={report.orthoAssetId ?? ''}
                    onChange={(e) =>
                      update('orthoAssetId', e.target.value ? Number(e.target.value) : null)
                    }
                  >
                    <option value="">— none —</option>
                    {orthoAssets.map(assetOption)}
                  </select>
                </div>
                {orthoAsset && (
                  <div className="text-[10px] text-gray-500 self-end pb-1">
                    {(() => {
                      const m = parseMetashapeMeta(orthoAsset);
                      if (!m) return null;
                      return (
                        <>
                          {METASHAPE_KIND_LABELS[m.kind] ?? m.kind}
                          {m.width ? ` · ${m.width}×${m.height}` : ''}
                          {m.crs ? ` · ${m.crs}` : ''}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}
            <div className="mt-2">
              <label className={labelCls}>Orthomosaic map link (e.g. hosted DJI Terra / Metashape output)</label>
              <input
                className={inputCls}
                value={report.orthomosaicLink}
                onChange={(e) => update('orthomosaicLink', e.target.value)}
                placeholder="https://…/stitched-thermal-map"
              />
            </div>
          </section>

          {/* Imaging log */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-drone-primary uppercase tracking-wide">
                4 · Thermal Imaging Log / Comparative Matrix
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
                5 · Anomalies & Findings
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

          {/* Action plan */}
          <section>
            <h3 className="text-xs font-semibold text-drone-primary uppercase tracking-wide mb-2">
              6 · Action Plan & Repair Prioritization
            </h3>
            <textarea
              className={`${inputCls} min-h-[80px]`}
              value={report.actionPlan}
              onChange={(e) => update('actionPlan', e.target.value)}
              placeholder={'1. (High) Repair active moisture intrusion at A-01 …\n2. (Medium) Re-insulate void at A-02 …\n3. Energy-saving upgrades: …'}
            />
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
