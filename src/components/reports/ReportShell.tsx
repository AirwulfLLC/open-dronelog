/**
 * ReportShell — the modal frame every report workflow shares: report name,
 * saved-report list (this kind only), Save, Preview (editable), Export as
 * PDF / Word / RTF, Export Bundle, notices, and the numbered sections
 * supplied by the workflow.
 *
 * Kind-specific behaviour is injected: how to normalize stored JSON, what to
 * inject right before save/export (e.g. the photogrammetry queue), which
 * assets a bundle must carry, how to resolve export-time content (`prepare`)
 * and how to render the document (`render`, against the ReportWriter
 * interface — the same renderer produces every format and the preview).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as thermalApi from '@/lib/thermalApi';
import { draftSection } from '@/lib/reports/ai';
import { saveReportFile } from '@/lib/reports/common';
import {
  EXPORT_FORMATS,
  renderPreviewHtml,
  renderToFormat,
  type ExportFormat,
  type ReportRenderer,
} from '@/lib/reports/export';
import { setPath } from '@/lib/reports/editPath';
import type { ReportBase, ReportKind, ThermalReportMeta } from '@/types/thermal';
import { ReportPreview } from './ReportPreview';
import type { ReportPatch, ReportSectionDef } from './types';

export interface PreviewEditResult {
  /** True when the workflow routed the edit itself (nothing to set on the report). */
  handled: boolean;
  /** True when the edit changed content that `prepare` captured (e.g. a
   *  picture note), so exports must prepare again. */
  invalidatesPrepared?: boolean;
}

export interface ReportShellProps<R extends ReportBase, P> {
  kind: ReportKind;
  title: string;
  icon: string;
  defaultName: string;
  /** Workflow name for the AI drafting prompt ("thermal inspection"). */
  aiWorkflow: string;
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
  /** Called with the serialized report after it was saved or exported to a
   *  file (not for previews or AI drafts). */
  onPersist?: (report: R) => void;
  /** Asset ids an inspection bundle must carry for this report. */
  referencedAssetIds: (report: R) => number[];
  /** Resolve export-time content (images, figures) for a serialized report. */
  prepare: (report: R) => Promise<P>;
  /** Render the report into any writer (file formats and the preview). */
  render: ReportRenderer<R, P>;
  /** Route a preview edit whose path is not a plain report field. */
  onPreviewEdit?: (path: string, value: string) => PreviewEditResult;
  /** Hook for "+ New blank" (e.g. offer to clear a shared queue). */
  onNewBlank?: () => void;
  onClose: () => void;
}

export function ReportShell<R extends ReportBase, P>({
  kind,
  title,
  icon,
  defaultName,
  aiWorkflow,
  empty,
  sections,
  normalize,
  onLoaded,
  serialize,
  onPersist,
  referencedAssetIds,
  prepare,
  render,
  onPreviewEdit,
  onNewBlank,
  onClose,
}: ReportShellProps<R, P>) {
  const [report, setReport] = useState<R>(empty);
  const [reportName, setReportName] = useState(defaultName);
  const [reportId, setReportId] = useState<number | null>(null);
  const [savedReports, setSavedReports] = useState<ThermalReportMeta[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  /** Open preview: its HTML and the prepared content it was rendered from. */
  const [preview, setPreview] = useState<{ html: string; prepared: P } | null>(null);
  // Set when a preview edit changed content that `prepare` captured
  const preparedStaleRef = useRef(false);
  /** null while unknown; false greys out AI drafting (no API key for the provider). */
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [aiBusyKey, setAiBusyKey] = useState<string | null>(null);
  /** Sections currently showing an AI draft → the user's text before it (for undo). */
  const [aiDrafts, setAiDrafts] = useState<Record<string, ReportPatch<R>>>({});
  // Latest state for async work (an AI reply must merge into what the user
  // has NOW, not what they had when the request started)
  const reportRef = useRef(report);
  reportRef.current = report;
  // Bumped whenever a different document is loaded; a draft started for the
  // previous document is then discarded instead of landing in the new one
  const documentGenRef = useRef(0);

  useEffect(() => {
    thermalApi
      .thermalAiHasApiKey()
      .then(setAiReady)
      .catch(() => setAiReady(false));
  }, []);

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

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const update = useCallback(
    (patch: ReportPatch<R>) => setReport((r) => ({ ...r, ...patch })),
    [],
  );

  const safeName = () =>
    (reportName || `${kind}-report`).replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '_');

  const handleSave = async () => {
    setBusy('save');
    try {
      const full = serialize(report);
      const id = await thermalApi.saveThermalReport(reportId, reportName, JSON.stringify(full));
      setReportId(id);
      onPersist?.(full);
      await refreshSavedReports();
      setNotice('Report saved.');
    } catch (e) {
      setNotice(`Save failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const handleLoad = async (meta: ThermalReportMeta) => {
    if (busy || aiBusyKey) return; // two quick clicks must not race two loads
    setBusy('load');
    try {
      const json = await thermalApi.getThermalReport(meta.id);
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const message = onLoaded?.(parsed);
      documentGenRef.current += 1;
      setReport(normalize(parsed));
      setReportName(meta.name);
      setReportId(meta.id);
      setAiDrafts({});
      setNotice(typeof message === 'string' ? message : null);
    } catch (e) {
      setNotice(`Load failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteSaved = async (meta: ThermalReportMeta) => {
    if (busy || aiBusyKey) return;
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
    if (busy || aiBusyKey) return;
    onNewBlank?.();
    documentGenRef.current += 1;
    setReport(empty());
    setReportId(null);
    setReportName(defaultName);
    setAiDrafts({});
  };

  /** Tick: draft the section from the entered data (keeping the user's text for undo). */
  const runAiDraft = async (s: ReportSectionDef<R>) => {
    const ai = s.ai;
    if (!ai || !aiReady) return;
    setAiBusyKey(s.key);
    const generation = documentGenRef.current;
    try {
      const full = serialize(report);
      const reply = await draftSection(aiWorkflow, ai.instruction(full), ai.facts(full));
      if (documentGenRef.current !== generation) {
        setNotice(`The AI draft for “${s.title}” was discarded because a different report was opened meanwhile.`);
        return;
      }
      // Merge into the state as it is NOW — the user may have edited other
      // entries while the model was writing
      const current = reportRef.current;
      const patch = ai.apply(current, reply);
      if (!patch) {
        setNotice(`The AI reply for “${s.title}” could not be applied — try again.`);
        return;
      }
      // Keep the first snapshot across regenerations so undo restores the original
      setAiDrafts((d) => (d[s.key] ? d : { ...d, [s.key]: ai.snapshot(current) }));
      setReport((r) => ({ ...r, ...patch }));
      setNotice(`AI draft applied to “${s.title}” — review and edit it; untick to restore your own text.`);
    } catch (e) {
      setNotice(`AI drafting failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setAiBusyKey(null);
    }
  };

  /** Untick: put the user's pre-draft text back (per entry where the section is a list). */
  const undoAiDraft = (s: ReportSectionDef<R>) => {
    const snapshot = aiDrafts[s.key];
    const ai = s.ai;
    if (snapshot && ai) {
      setReport((r) => ({ ...r, ...(ai.restore ? ai.restore(r, snapshot) : snapshot) }));
    }
    setAiDrafts((d) => {
      const next = { ...d };
      delete next[s.key];
      return next;
    });
  };

  const aiTitle = (s: ReportSectionDef<R>) =>
    aiReady === false
      ? 'Configure an AI API key in Settings (AI Thermal Analysis) to enable AI drafting'
      : aiDrafts[s.key]
        ? 'Showing an AI draft — untick to restore your own text'
        : `Draft the ${s.title} text with AI from the data entered in this report`;

  /** Export-time content: reuse the open preview's unless an edit invalidated it. */
  const preparedFor = async (full: R): Promise<P> => {
    if (preview && !preparedStaleRef.current) return preview.prepared;
    const prepared = await prepare(full);
    preparedStaleRef.current = false;
    if (preview) setPreview((p) => (p ? { ...p, prepared } : p));
    return prepared;
  };

  const handleExport = async (format: ExportFormat) => {
    setExportMenuOpen(false);
    setBusy(format);
    try {
      const full = serialize(report);
      const prepared = await preparedFor(full);
      const out = await renderToFormat(format, render, full, prepared);
      const info = EXPORT_FORMATS[format];
      const ok = await saveReportFile(`${safeName()}.${info.ext}`, out, info.filter, info.ext, info.mime);
      if (ok) {
        onPersist?.(full);
        setNotice(`${info.label} exported.`);
      }
    } catch (e) {
      setNotice(`${EXPORT_FORMATS[format].label} export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const handlePreview = async () => {
    setBusy('preview');
    try {
      const full = serialize(report);
      const prepared = await prepare(full);
      preparedStaleRef.current = false;
      setPreview({ html: renderPreviewHtml(render, full, prepared), prepared });
    } catch (e) {
      setNotice(`Preview failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const handlePreviewEdit = (path: string, value: string) => {
    const result = onPreviewEdit?.(path, value);
    if (result?.handled) {
      if (result.invalidatesPrepared) preparedStaleRef.current = true;
      return;
    }
    setReport((r) => setPath(r, path, value));
  };

  /** The PDF rendition of the current state, for the preview's PDF tab. */
  const makePdf = async (): Promise<Uint8Array> => {
    const full = serialize(report);
    const prepared = await preparedFor(full);
    return (await renderToFormat('pdf', render, full, prepared)) as Uint8Array;
  };

  const handleExportBundle = async () => {
    setExportMenuOpen(false);
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

  const busyLabel = (key: string, idle: string) => (busy === key ? 'Working…' : idle);

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
              className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white w-44"
              placeholder="Report name"
            />
            <button
              onClick={handleSave}
              disabled={busy != null || aiBusyKey != null}
              title={aiBusyKey ? 'Wait for the AI draft to finish' : undefined}
              className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium disabled:opacity-50"
            >
              {busy === 'save' ? 'Saving…' : reportId ? 'Save' : 'Save as new'}
            </button>
            <button
              onClick={handlePreview}
              disabled={busy != null}
              title="See the report as it will export and edit its text in place"
              className="px-3 py-1.5 rounded bg-sky-600/80 hover:bg-sky-600 text-white text-xs font-medium disabled:opacity-50"
            >
              {busy === 'preview' ? 'Preparing…' : 'Preview & edit'}
            </button>
            <div ref={exportMenuRef} className="relative">
              <button
                onClick={() => setExportMenuOpen((o) => !o)}
                disabled={busy != null}
                className="px-3 py-1.5 rounded bg-drone-primary hover:bg-drone-primary/80 text-white text-xs font-medium disabled:opacity-50 flex items-center gap-1.5"
              >
                {busy && busy in EXPORT_FORMATS ? 'Exporting…' : 'Export'}
                <span className={`text-[9px] transition-transform ${exportMenuOpen ? 'rotate-180' : ''}`}>▼</span>
              </button>
              {exportMenuOpen && (
                <div className="absolute right-0 mt-1 w-44 rounded-lg border border-gray-600 bg-gray-800 shadow-xl z-50 py-1 text-xs">
                  {(Object.keys(EXPORT_FORMATS) as ExportFormat[]).map((f) => (
                    <button
                      key={f}
                      onClick={() => handleExport(f)}
                      className="w-full text-left px-3 py-2 text-gray-200 hover:bg-drone-primary/20"
                    >
                      {EXPORT_FORMATS[f].label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={handleExportBundle}
              disabled={busy != null}
              title="Save the complete inspection — report, assets, annotations, networks and linked flight data — as a single portable file"
              className="px-3 py-1.5 rounded bg-emerald-600/80 hover:bg-emerald-600 text-white text-xs font-medium disabled:opacity-50"
            >
              {busyLabel('bundle', 'Export Bundle')}
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
                  disabled={busy != null || aiBusyKey != null}
                  className="px-2 py-1 rounded border border-dashed border-gray-600 text-[11px] text-gray-400 hover:text-white disabled:opacity-50"
                >
                  + New blank
                </button>
              </div>
            </section>
          )}

          {sections.map((s, i) => (
            <section key={s.key}>
              <div className="flex items-center justify-between mb-2 gap-3">
                <h3 className="text-xs font-semibold text-drone-primary uppercase tracking-wide">
                  {i + 1} · {s.title}
                </h3>
                <div className="flex items-center gap-2">
                  {s.ai && (
                    <div className="flex items-center gap-1.5" title={aiTitle(s)}>
                      <label
                        className={`inline-flex items-center gap-1 text-[10px] select-none ${
                          aiReady ? 'text-violet-200 cursor-pointer' : 'text-gray-600 cursor-not-allowed'
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="accent-violet-500"
                          disabled={!aiReady || busy != null || aiBusyKey != null}
                          checked={!!aiDrafts[s.key]}
                          onChange={(e) => (e.target.checked ? runAiDraft(s) : undoAiDraft(s))}
                        />
                        ✨ AI draft
                      </label>
                      {aiBusyKey === s.key && (
                        <span className="text-[10px] text-violet-300 animate-pulse">writing…</span>
                      )}
                      {aiDrafts[s.key] && aiBusyKey !== s.key && (
                        <button
                          onClick={() => runAiDraft(s)}
                          disabled={busy != null || aiBusyKey != null}
                          className="text-[11px] text-violet-300 hover:text-white disabled:opacity-40"
                          title="Regenerate the AI draft"
                        >
                          ↻
                        </button>
                      )}
                    </div>
                  )}
                  {s.Actions && <s.Actions report={report} update={update} setNotice={setNotice} />}
                </div>
              </div>
              <s.Component report={report} update={update} setNotice={setNotice} />
            </section>
          ))}
        </div>
      </div>

      {preview && (
        <ReportPreview
          html={preview.html}
          busy={busy}
          onEdit={handlePreviewEdit}
          onExport={handleExport}
          makePdf={makePdf}
          onRefresh={handlePreview}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
