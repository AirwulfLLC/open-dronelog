/**
 * Turn a report renderer into a file of a given format, or into the editable
 * preview HTML. Formats are the writers in this folder.
 */

import { createDocxWriter } from './docxWriter';
import { HtmlWriter } from './htmlWriter';
import { createPdfWriter } from './pdfWriter';
import { RtfWriter } from './rtfWriter';
import type { ReportWriter } from './writer';

export type ExportFormat = 'pdf' | 'docx' | 'rtf';

export interface FormatInfo {
  label: string;
  ext: string;
  filter: string;
  mime: string;
}

export const EXPORT_FORMATS: Record<ExportFormat, FormatInfo> = {
  pdf: { label: 'PDF', ext: 'pdf', filter: 'PDF Report', mime: 'application/pdf' },
  docx: {
    label: 'Word (.docx)',
    ext: 'docx',
    filter: 'Word Document',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  rtf: { label: 'RTF', ext: 'rtf', filter: 'RTF Report', mime: 'application/rtf' },
};

export type ReportRenderer<R, P> = (w: ReportWriter, report: R, prepared: P) => void;

export async function renderToFormat<R, P>(
  format: ExportFormat,
  render: ReportRenderer<R, P>,
  report: R,
  prepared: P,
): Promise<Uint8Array | string> {
  switch (format) {
    case 'pdf': {
      const w = await createPdfWriter();
      render(w, report, prepared);
      return w.bytes();
    }
    case 'docx': {
      const w = await createDocxWriter();
      render(w, report, prepared);
      return w.finish();
    }
    case 'rtf': {
      const w = new RtfWriter();
      render(w, report, prepared);
      return w.finish();
    }
  }
}

export function renderPreviewHtml<R, P>(render: ReportRenderer<R, P>, report: R, prepared: P): string {
  const w = new HtmlWriter();
  render(w, report, prepared);
  return w.finish();
}
