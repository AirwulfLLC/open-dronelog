/**
 * PDF implementation of ReportWriter over jsPDF (A4, millimetres).
 */

import type { jsPDF } from 'jspdf';
import {
  CONTENT_WIDTH_MM,
  FIGURE_MAX_H_MM,
  cellText,
  figureTitle,
  type EditRef,
  type FigureSpec,
  type ImagePairSpec,
  type KvOptions,
  type NoteSpec,
  type ReportWriter,
  type TableCell,
  type TableColumn,
  type TextOptions,
} from './writer';

const ACCENT: [number, number, number] = [20, 60, 110];
const GRAY: [number, number, number] = [110, 110, 110];

export class PdfWriter implements ReportWriter {
  readonly editable = false;
  readonly doc: jsPDF;
  readonly pageW: number;
  readonly pageH: number;
  readonly margin = 16;
  readonly contentW: number;
  /** Current baseline (mm from the top of the page). */
  y: number;
  private sectionNo = 1;

  constructor(doc: jsPDF) {
    this.doc = doc;
    this.pageW = doc.internal.pageSize.getWidth();
    this.pageH = doc.internal.pageSize.getHeight();
    this.contentW = this.pageW - this.margin * 2;
    this.y = this.margin;
  }

  /** Start a new page when `needed` mm would not fit above the bottom margin. */
  checkPage(needed: number): void {
    if (this.y + needed > this.pageH - this.margin) {
      this.doc.addPage();
      this.y = this.margin;
    }
  }

  title(text: string, subtitle: string): void {
    const { doc } = this;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(19);
    doc.setTextColor(...ACCENT);
    doc.text(text, this.margin, this.y + 4);
    this.y += 12;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    doc.text(subtitle, this.margin, this.y);
    doc.setTextColor(0, 0, 0);
    this.y += 8;
  }

  sectionHeading(title: string, size = 13): void {
    this.heading(`${this.sectionNo++}. ${title}`, size);
  }

  heading(text: string, size = 13): void {
    const { doc } = this;
    this.checkPage(12);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.setTextColor(...ACCENT);
    doc.text(text, this.margin, this.y);
    this.y += 2;
    doc.setDrawColor(...ACCENT);
    doc.setLineWidth(0.4);
    doc.line(this.margin, this.y, this.margin + this.contentW, this.y);
    this.y += 6;
    doc.setTextColor(0, 0, 0);
  }

  subheading(text: string, _edit?: EditRef): void {
    const { doc } = this;
    const lines = this.lineCount(text, 10, true);
    // Keep a label together with at least the first lines that follow it
    this.checkPage(Math.max(lines * 5, 14));
    doc.setTextColor(0, 0, 0);
    doc.text(doc.splitTextToSize(text, this.contentW) as string[], this.margin, this.y);
    this.y += lines * 5;
  }

  paragraph(text: string, options?: TextOptions): void {
    const body = text.trim() ? text : options?.placeholder ?? '';
    if (!body.trim()) return;
    const { doc } = this;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(options?.size ?? 10);
    doc.setTextColor(0, 0, 0);
    const lines = doc.splitTextToSize(body, this.contentW) as string[];
    for (const line of lines) {
      this.checkPage(6);
      doc.text(line, this.margin, this.y);
      this.y += 5;
    }
    this.y += 2;
  }

  /** Wrapped lines in a given font size/leading/color. */
  lines(text: string, size: number, lineH: number, color: [number, number, number] = [0, 0, 0]): void {
    if (!text.trim()) return;
    const { doc } = this;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(text, this.contentW) as string[];
    for (const line of lines) {
      this.checkPage(Math.max(5, lineH));
      doc.text(line, this.margin, this.y);
      this.y += lineH;
    }
    doc.setTextColor(0, 0, 0);
  }

  /** Number of wrapped lines `text` takes at the given font — and leaves that
   *  font selected, so a following draw call measures and draws alike. */
  lineCount(text: string, size: number, bold = false): number {
    this.doc.setFont('helvetica', bold ? 'bold' : 'normal');
    this.doc.setFontSize(size);
    return (this.doc.splitTextToSize(text, this.contentW) as string[]).length;
  }

  detail(text: string): void {
    this.lines(text, 8.5, 4.2);
  }

  smallText(text: string): void {
    this.lines(text, 8, 4, GRAY);
  }

  boldLine(text: string): void {
    const { doc } = this;
    // Keep the label together with at least the first lines that follow it
    this.checkPage(14);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(0, 0, 0);
    doc.text(text, this.margin, this.y);
    this.y += 4.5;
  }

  kv(key: string, value: string, _edit?: EditRef, options?: KvOptions): void {
    const { doc } = this;
    if (options?.compact) {
      this.checkPage(5);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(0, 0, 0);
      doc.text(`${key}: `, this.margin, this.y);
      doc.setFont('helvetica', 'normal');
      const lines = doc.splitTextToSize(value || '—', this.contentW - 30) as string[];
      doc.text(lines, this.margin + 30, this.y);
      this.y += Math.max(4, lines.length * 4);
      return;
    }
    this.checkPage(6);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(0, 0, 0);
    doc.text(`${key}:`, this.margin, this.y);
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(value || '—', this.contentW - 48) as string[];
    doc.text(lines, this.margin + 48, this.y);
    this.y += Math.max(5, lines.length * 5);
  }

  link(url: string): void {
    const { doc } = this;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(20, 90, 200);
    this.checkPage(6);
    doc.textWithLink(url, this.margin, this.y, { url });
    doc.setTextColor(0, 0, 0);
    this.y += 7;
  }

  /** Embed a PNG/JPEG data URL; false when jsPDF rejects it. */
  image(dataUrl: string, x: number, y: number, w: number, h: number): boolean {
    try {
      const fmt = dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG';
      this.doc.addImage(dataUrl, fmt, x, y, w, h, undefined, 'FAST');
      return true;
    } catch {
      return false;
    }
  }

  placeholder(x: number, y: number, w: number, h: number, label: string): void {
    const { doc } = this;
    doc.setDrawColor(180, 180, 180);
    doc.rect(x, y, w, h);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text(label, x + w / 2, y + h / 2, { align: 'center' });
    doc.setTextColor(0, 0, 0);
  }

  figure(spec: FigureSpec): void {
    const aspect = spec.aspect > 0 ? spec.aspect : 0.75;
    // Never taller than the page body, whatever the caller asks for
    const maxH = Math.min(spec.maxHeightMm ?? FIGURE_MAX_H_MM, this.pageH - this.margin * 2 - 24);
    let imgW = this.contentW;
    let imgH = imgW * aspect;
    if (imgH > maxH) {
      imgH = maxH;
      imgW = imgH / aspect;
    }
    const title = figureTitle(spec);
    // Measure in the font subheading() draws with, not whatever the previous
    // helper left selected
    const titleLines = title ? this.lineCount(title, 10, true) : 0;
    this.checkPage(imgH + 13 + titleLines * 5);
    if (title) this.subheading(title);
    const x = this.margin + (this.contentW - imgW) / 2;
    if (!spec.image || !this.image(spec.image, x, this.y, imgW, imgH)) {
      this.placeholder(x, this.y, imgW, imgH, 'Image unavailable');
    }
    this.y += imgH + 3;
    this.smallText(spec.details);
    if (spec.note?.trim()) this.notes([{ label: 'Note', text: spec.note }]);
    this.y += 5;
  }

  imagePair(spec: ImagePairSpec): void {
    const { doc } = this;
    const colW = (this.contentW - 6) / 2;
    const imgH = colW * 0.75;
    const title = `${spec.index}. ${spec.caption || 'Imaging pair'}`;
    const details = spec.details?.trim() ?? '';
    this.checkPage(imgH + 21 + this.lineCount(title, 10, true) * 5 + (details ? 5 : 0));
    this.subheading(title);

    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    doc.text(spec.leftLabel, this.margin, this.y);
    doc.text(spec.rightLabel, this.margin + colW + 6, this.y);
    doc.setTextColor(0, 0, 0);
    this.y += 2;

    const draw = (dataUrl: string | null, x: number) => {
      if (!dataUrl || !this.image(dataUrl, x, this.y, colW, imgH)) {
        this.placeholder(x, this.y, colW, imgH, 'No image');
      }
    };
    draw(spec.leftImage, this.margin);
    draw(spec.rightImage, this.margin + colW + 6);
    this.y += imgH + 4;
    if (details) this.smallText(details);
  }

  notes(notes: NoteSpec[]): void {
    const { doc } = this;
    for (const n of notes) {
      if (!n.text.trim()) continue;
      const label = `${n.label}: `;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(0, 0, 0);
      const labelW = doc.getTextWidth(label);
      doc.setFont('helvetica', 'normal');
      const lines = doc.splitTextToSize(n.text, this.contentW - labelW) as string[];
      this.checkPage(lines.length * 4.2 + 1);
      doc.setFont('helvetica', 'bold');
      doc.text(label, this.margin, this.y);
      doc.setFont('helvetica', 'normal');
      doc.text(lines, this.margin + labelW, this.y);
      this.y += lines.length * 4.2 + 1;
    }
  }

  table(cols: TableColumn[], rows: TableCell[][]): void {
    const { doc } = this;
    const drawHeader = () => {
      doc.setFillColor(...ACCENT);
      doc.rect(this.margin, this.y - 4, this.contentW, 6, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(255, 255, 255);
      let x = this.margin + 1.5;
      for (const c of cols) {
        doc.text(c.label, x, this.y);
        x += c.w;
      }
      doc.setTextColor(0, 0, 0);
      this.y += 5;
    };
    this.checkPage(20);
    drawHeader();
    doc.setFont('helvetica', 'normal');
    for (const cells of rows) {
      doc.setFontSize(7.5);
      const wrapped = cells.map((cell, i) => doc.splitTextToSize(cellText(cell), cols[i].w - 3) as string[]);
      const rowH = Math.max(...wrapped.map((wl) => wl.length)) * 3.4 + 2.5;
      if (this.y + rowH > this.pageH - this.margin) {
        doc.addPage();
        this.y = this.margin + 4;
        drawHeader();
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5); // header set 8pt; rows were wrapped at 7.5pt
      }
      let x = this.margin + 1.5;
      for (let i = 0; i < wrapped.length; i++) {
        doc.text(wrapped[i], x, this.y);
        x += cols[i].w;
      }
      this.y += rowH;
      doc.setDrawColor(210, 210, 210);
      doc.setLineWidth(0.15);
      doc.line(this.margin, this.y - 2, this.margin + this.contentW, this.y - 2);
    }
    this.y += 3;
  }

  space(mm = 3): void {
    this.y += mm;
  }

  footers(left: string): void {
    const { doc } = this;
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(140, 140, 140);
      doc.text(`Page ${p} of ${pages}`, this.pageW - this.margin, this.pageH - 8, { align: 'right' });
      if (left.trim()) doc.text(left, this.margin, this.pageH - 8);
    }
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.doc.output('arraybuffer'));
  }
}

/** jsPDF is loaded on demand — it is several hundred kB and only reports need it. */
export async function createPdfWriter(): Promise<PdfWriter> {
  const { jsPDF } = await import('jspdf');
  const w = new PdfWriter(new jsPDF({ unit: 'mm', format: 'a4' }));
  if (Math.abs(w.contentW - CONTENT_WIDTH_MM) > 1) {
    console.warn(`PDF content width ${w.contentW} mm differs from the ${CONTENT_WIDTH_MM} mm the table columns assume`);
  }
  return w;
}
