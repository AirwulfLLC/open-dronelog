/**
 * Thin layout layer over jsPDF shared by every report kind: numbered section
 * headings, wrapped paragraphs, key/value rows, images with placeholders,
 * paginated tables and page footers. Builders compose sections from these so
 * a new section (or a new report kind) never re-implements pagination.
 *
 * All metrics are millimetres on A4.
 */

import type { jsPDF } from 'jspdf';

export interface TableColumn {
  label: string;
  /** Column width in mm. */
  w: number;
}

const ACCENT: [number, number, number] = [20, 60, 110];
const GRAY: [number, number, number] = [110, 110, 110];

export class PdfWriter {
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

  /** Document title with a small gray provenance line beneath it. */
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

  /** Numbered section heading ("3. Flight Operations") with an underline. */
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

  /** Bold one-line label (flight names, figure titles); wraps when long. */
  subheading(text: string, size = 10): void {
    const { doc } = this;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.setTextColor(0, 0, 0);
    const lines = doc.splitTextToSize(text, this.contentW) as string[];
    this.checkPage(lines.length * 5);
    doc.text(lines, this.margin, this.y);
    this.y += lines.length * 5;
  }

  /** Wrapped body text; silently skips blank input. */
  paragraph(text: string, size = 10): void {
    if (!text.trim()) return;
    const { doc } = this;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(size);
    doc.setTextColor(0, 0, 0);
    const lines = doc.splitTextToSize(text, this.contentW) as string[];
    for (const line of lines) {
      this.checkPage(6);
      doc.text(line, this.margin, this.y);
      this.y += 5;
    }
    this.y += 2;
  }

  /** Wrapped small lines in a given color (details, captions, provenance). */
  lines(text: string, size: number, lineH: number, color: [number, number, number] = [0, 0, 0]): void {
    if (!text.trim()) return;
    const { doc } = this;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(text, this.contentW) as string[];
    for (const line of lines) {
      this.checkPage(lineH + 0.5);
      doc.text(line, this.margin, this.y);
      this.y += lineH;
    }
    doc.setTextColor(0, 0, 0);
  }

  /** Gray 8pt detail line(s). */
  gray(text: string): void {
    this.lines(text, 8, 4, GRAY);
  }

  /** "Key:  value" row with the value wrapped in the right-hand column. */
  kv(key: string, value: string): void {
    const { doc } = this;
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

  /** Clickable URL in link blue. */
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

  /** Outlined box with a centered gray label where an image should have been. */
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

  /**
   * Fixed-column table with a filled header row, wrapped cells and header
   * repetition on page breaks. Cell strings may contain '\n'.
   */
  table(cols: TableColumn[], rows: string[][]): void {
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
      const wrapped = cells.map((cell, i) => doc.splitTextToSize(cell, cols[i].w - 3) as string[]);
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

  /** "Page n of N" bottom-right and an optional left-hand running text. */
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
  return new PdfWriter(new jsPDF({ unit: 'mm', format: 'a4' }));
}
