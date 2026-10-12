/**
 * ReportPreview — shows the report as it will export. The "Edit" tab is the
 * HTML rendition with every report text editable in place (edits flow back
 * into the report document immediately); the "PDF" tab shows the actual PDF
 * rendition of the current state. Exports can be started from here.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { EXPORT_FORMATS, type ExportFormat } from '@/lib/reports/export';
import { PREVIEW_STYLES } from '@/lib/reports/htmlWriter';

interface Props {
  html: string;
  busy: string | null;
  onEdit: (path: string, value: string) => void;
  onExport: (format: ExportFormat) => void;
  /** The PDF rendition of the current report state. */
  makePdf: () => Promise<Uint8Array>;
  /** Regenerate the editable rendition from the current state. */
  onRefresh: () => void;
  onClose: () => void;
}

type Mode = 'edit' | 'pdf';

export function ReportPreview({ html, busy, onEdit, onExport, makePdf, onRefresh, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('edit');
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  // The live blob URL, so unmount can revoke it without going through state
  const pdfUrlRef = useRef<string | null>(null);

  // The edit DOM is written once per `html` and then owned by the user's
  // edits — React never re-renders it, so the caret and typed text survive.
  useEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = html;
  }, [html]);

  const replacePdfUrl = useCallback((url: string | null) => {
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    pdfUrlRef.current = url;
    setPdfUrl(url);
  }, []);

  // Each visit to the PDF tab renders the current state (edits may have happened)
  useEffect(() => {
    if (mode !== 'pdf') return;
    let cancelled = false;
    setPdfLoading(true);
    setPdfError(null);
    makePdf()
      .then((bytes) => {
        if (cancelled) return;
        replacePdfUrl(URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' })));
      })
      .catch((e) => {
        if (!cancelled) setPdfError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setPdfLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // makePdf is recreated every render; the tab switch is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(
    () => () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    },
    [],
  );

  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-edit]');
    if (!el?.dataset.edit) return;
    // innerText keeps the line breaks the user typed; a field emptied by the
    // user may leave a stray <br> behind, which innerText reads as '\n'
    const text = el.innerText.replace(/\n$/, '');
    if (!text.trim() && el.childNodes.length > 0) {
      // Drop the leftover <br> so the field is truly empty and its hint shows
      el.innerHTML = '';
    }
    onEdit(el.dataset.edit, el.dataset.single ? text.replace(/\n+/g, ' ') : text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-edit]');
    if (el?.dataset.single) {
      e.preventDefault();
      el.blur();
    }
  };

  // Keep pasted content plain so no foreign formatting lands in the report
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-edit]');
    if (!el) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, el.dataset.single ? text.replace(/\n+/g, ' ') : text);
  };

  const tab = (key: Mode, label: string) => (
    <button
      onClick={() => setMode(key)}
      className={`px-3 py-1 rounded text-xs ${
        mode === key ? 'bg-drone-primary/25 text-white border border-drone-primary' : 'text-gray-400 hover:text-white border border-transparent'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[110] bg-black/70 flex items-center justify-center p-3">
      <div className="w-full max-w-5xl h-[94vh] bg-drone-secondary border border-gray-700 rounded-xl flex flex-col overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">Preview</span>
            {tab('edit', 'Edit')}
            {tab('pdf', 'PDF')}
            <span className="text-[10px] text-gray-500 ml-2 hidden md:inline">
              {mode === 'edit'
                ? 'Click any text to edit it in place — changes apply to the report immediately.'
                : 'The exported PDF, rendered from the current report.'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {mode === 'edit' && (
              <button
                onClick={onRefresh}
                disabled={busy != null}
                title="Re-render after changing images, figures or sections in the builder"
                className="px-2.5 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-white text-xs disabled:opacity-50"
              >
                {busy === 'preview' ? 'Preparing…' : 'Refresh'}
              </button>
            )}
            {(Object.keys(EXPORT_FORMATS) as ExportFormat[]).map((f) => (
              <button
                key={f}
                onClick={() => onExport(f)}
                disabled={busy != null}
                className="px-2.5 py-1.5 rounded bg-drone-primary hover:bg-drone-primary/80 text-white text-xs font-medium disabled:opacity-50"
              >
                {busy === f ? 'Exporting…' : `Export ${EXPORT_FORMATS[f].label}`}
              </button>
            ))}
            <button onClick={onClose} className="ml-1 text-gray-400 hover:text-white px-2 py-1">
              ✕
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 relative bg-gray-900">
          {/* Both renditions stay mounted: switching tabs must not discard the edited DOM */}
          <div className={`absolute inset-0 overflow-y-auto py-6 px-3 ${mode === 'edit' ? '' : 'hidden'}`}>
            <style>{PREVIEW_STYLES}</style>
            <div ref={editorRef} onInput={handleInput} onKeyDown={handleKeyDown} onPaste={handlePaste} />
          </div>
          <div className={`absolute inset-0 ${mode === 'pdf' ? '' : 'hidden'}`}>
            {pdfLoading && (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400 animate-pulse">
                Rendering PDF…
              </div>
            )}
            {pdfError && (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-red-300 px-6 text-center">
                PDF rendering failed: {pdfError}
              </div>
            )}
            {pdfUrl && !pdfLoading && (
              <iframe title="PDF preview" src={pdfUrl} className="w-full h-full border-0 bg-white" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
