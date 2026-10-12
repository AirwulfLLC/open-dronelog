/**
 * ReportShell — the modal frame every report workflow shares: report name,
 * saved-report list (this kind only), Save / Export PDF / Export RTF / Export
 * Bundle, notices, and the numbered sections supplied by the workflow.
 *
 * Kind-specific behaviour is injected: how to normalize stored JSON, what to
 * inject right before save/export (e.g. the photogrammetry queue), which
 * assets a bundle must carry, and the PDF/RTF builders.
 */

import { useCallback, useEffect, useState } from 'react';
import * as thermalApi from '@/lib/thermalApi';
import { saveReportFile } from '@/lib/reports/common';
import type { ReportBase, ReportKind, ThermalReportMeta } from '@/types/thermal';
import type { ReportPatch, ReportSectionDef } from './types';

export interface ReportShellProps<R extends ReportBase> {
  kind: ReportKind;
  title: string;
  icon: string;
  defaultName: string;
  /** A fresh report of this kind. */
  empty: () => R;
  sections: ReportSectionDef<R>[];
  /** Turn stored JSON (possibly from an older version) into a valid report. */
  normalize: (parsed: Record<string, unknown>) => R;
  /** Side effects of loading a saved report (e.g. restoring a shared queue).
   *  A returned string is shown to the user as a notice. */
  onLoaded?: (parsed: Record<string, unknown>) => string | void;
  /** Inject live data right before save/export. */
  serialize: (report: R) => R;
  /** Asset ids an inspection bundle must carry for this report. */
  referencedAssetIds: (report: R) => number[];
  buildPdf: (report: R) => Promise<Uint8Array>;
  buildRtf: (report: R) => Promise<string>;
  /** Hook for "+ New blank" (e.g. offer to clear a shared queue). */
  onNewBlank?: () => void;
  onClose: () => void;
}

export function ReportShell<R extends ReportBase>({
  kind,
  title,
  icon,
  defaultName,
  empty,
  sections,
  normalize,
  onLoaded,
  serialize,
  referencedAssetIds,
  buildPdf,
  buildRtf,
  onNewBlank,
  onClose,
}: ReportShellProps<R>) {
  const [report, setReport] = useState<R>(empty);
  const [reportName, setReportName] = useState(defaultName);
  const [reportId, setReportId] = useState<number | null>(null);
  const [savedReports, setSavedReports] = useState<ThermalReportMeta[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshSavedReports = useCallback(async () => {
    try {
      const all = await thermalApi.listThermalReports();
      // Each workflow lists only its own documents
      setSavedReports(all.filter((m) => m.kind === kind));
    } catch {
      // list is non-critical
    }
  }, [kind]);

  useEffect(() => {
    refreshSavedReports();
  }, [refreshSavedReports]);

  const update = useCallback(
    (patch: ReportPatch<R>) => setReport((r) => ({ ...r, ...patch })),
    [],
  );

  const safeName = () =>
    (reportName || `${kind}-report`).replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '_');

  const handleSave = async () => {
    setBusy('save');
    try {
      const id = await thermalApi.saveThermalReport(
        reportId,
        reportName,
        JSON.stringify(serialize(report)),
      );
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
    if (busy) return; // two quick clicks must not race two loads
    setBusy('load');
    try {
      const json = await thermalApi.getThermalReport(meta.id);
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const message = onLoaded?.(parsed);
      setReport(normalize(parsed));
      setReportName(meta.name);
      setReportId(meta.id);
      setNotice(typeof message === 'string' ? message : null);
    } catch (e) {
      setNotice(`Load failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteSaved = async (meta: ThermalReportMeta) => {
    if (busy) return;
    if (!window.confirm(`Delete saved report "${meta.name}"?`)) return;
    try {
      await thermalApi.deleteThermalReport(meta.id);
      if (reportId === meta.id) setReportId(null);
      await refreshSavedReports();
    } catch (e) {
      setNotice(`Delete failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const handleNewBlank = () => {
    onNewBlank?.();
    setReport(empty());
    setReportId(null);
    setReportName(defaultName);
  };

  const handleExportPdf = async () => {
    setBusy('pdf');
    try {
      const pdf = await buildPdf(serialize(report));
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
      const rtf = await buildRtf(serialize(report));
      const ok = await saveReportFile(`${safeName()}.rtf`, rtf, 'RTF Report', 'rtf');
      if (ok) setNotice('RTF exported.');
    } catch (e) {
      setNotice(`RTF export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

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
      const full = serialize(report);
      await thermalApi.exportThermalBundle({
        destPath: dest,
        name: reportName || defaultName,
        reportJson: JSON.stringify(full),
        assetIds: referencedAssetIds(full),
        flightIds: full.linkedFlights.map((f) => f.id),
      });
      setNotice('Inspection bundle exported.');
    } catch (e) {
      setNotice(`Bundle export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl max-h-[92vh] bg-drone-secondary border border-gray-700 rounded-xl flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            {icon} {title}
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
          {/* Saved reports of this kind */}
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
                  onClick={handleNewBlank}
                  className="px-2 py-1 rounded border border-dashed border-gray-600 text-[11px] text-gray-400 hover:text-white"
                >
                  + New blank
                </button>
              </div>
            </section>
          )}

          {sections.map((s, i) => (
            <section key={s.key}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-drone-primary uppercase tracking-wide">
                  {i + 1} · {s.title}
                </h3>
                {s.Actions && <s.Actions report={report} update={update} setNotice={setNotice} />}
              </div>
              <s.Component report={report} update={update} setNotice={setNotice} />
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
