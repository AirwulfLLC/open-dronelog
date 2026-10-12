/**
 * Word (.docx) implementation of ReportWriter over the `docx` package
 * (A4, 2 cm margins). The library is loaded on demand like jsPDF.
 */

import type * as DocxModule from 'docx';
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

type Docx = typeof DocxModule;
type Child = DocxModule.Paragraph | DocxModule.Table;

const ACCENT = '143C6E';
const GRAY = '6E6E6E';
/** 2 cm margins on A4 → 17 cm content width ≈ 643 px at 96 dpi. */
const CONTENT_PX = 640;
/** Page body height in px, the hard cap for any image. */
const BODY_MAX_H_PX = 900;
const PAGE = { width: 11906, height: 16838 };
const MARGIN = 1134;

const mmToPx = (mm: number) => (CONTENT_PX * mm) / CONTENT_WIDTH_MM;

function imageType(dataUrl: string): 'png' | 'jpg' {
  return dataUrl.startsWith('data:image/png') ? 'png' : 'jpg';
}

export class DocxWriter implements ReportWriter {
  readonly editable = false;
  private readonly d: Docx;
  private readonly children: Child[] = [];
  private sectionNo = 1;
  private footerLeft = '';

  constructor(docx: Docx) {
    this.d = docx;
  }

  private run(text: string, opts: Partial<DocxModule.IRunOptions> = {}): DocxModule.TextRun {
    return new this.d.TextRun({ text, ...opts });
  }

  /** One paragraph per line of `text`, so '\n' survives into Word. */
  private textParagraphs(
    text: string,
    runOpts: Partial<DocxModule.IRunOptions>,
    paraOpts: Omit<DocxModule.IParagraphOptions, 'children' | 'text'> = {},
  ): DocxModule.Paragraph[] {
    return text.split('\n').map(
      (line) => new this.d.Paragraph({ ...paraOpts, children: [this.run(line, runOpts)] }),
    );
  }

  title(text: string, subtitle: string): void {
    this.children.push(
      new this.d.Paragraph({
        spacing: { after: 120 },
        children: [this.run(text, { bold: true, size: 38, color: ACCENT })],
      }),
      new this.d.Paragraph({
        spacing: { after: 240 },
        children: [this.run(subtitle, { size: 18, color: GRAY })],
      }),
    );
  }

  sectionHeading(title: string): void {
    this.children.push(
      new this.d.Paragraph({
        heading: this.d.HeadingLevel.HEADING_1,
        spacing: { before: 280, after: 120 },
        children: [this.run(`${this.sectionNo++}. ${title}`, { bold: true, size: 26, color: ACCENT })],
      }),
    );
  }

  subheading(text: string): void {
    this.children.push(
      new this.d.Paragraph({
        keepNext: true,
        spacing: { before: 120, after: 60 },
        children: [this.run(text, { bold: true, size: 20 })],
      }),
    );
  }

  paragraph(text: string, options?: TextOptions): void {
    const body = text.trim() ? text : options?.placeholder ?? '';
    if (!body.trim()) return;
    this.children.push(
      ...this.textParagraphs(body, { size: (options?.size ?? 10) * 2 }, { spacing: { after: 120 } }),
    );
  }

  detail(text: string): void {
    if (!text.trim()) return;
    this.children.push(...this.textParagraphs(text, { size: 17 }, { spacing: { after: 40 } }));
  }

  smallText(text: string): void {
    if (!text.trim()) return;
    this.children.push(...this.textParagraphs(text, { size: 16, color: GRAY }, { spacing: { after: 120 } }));
  }

  boldLine(text: string): void {
    this.children.push(
      new this.d.Paragraph({
        keepNext: true,
        spacing: { before: 60, after: 20 },
        children: [this.run(text, { bold: true, size: 18 })],
      }),
    );
  }

  kv(key: string, value: string, _edit?: EditRef, options?: KvOptions): void {
    const size = options?.compact ? 16 : 20;
    this.children.push(
      new this.d.Paragraph({
        spacing: { after: 60 },
        children: [this.run(`${key}: `, { bold: true, size }), this.run(value || '—', { size })],
      }),
    );
  }

  link(url: string): void {
    if (!url.trim()) return;
    this.children.push(
      new this.d.Paragraph({
        spacing: { after: 120 },
        children: [
          new this.d.ExternalHyperlink({
            link: url,
            children: [this.run(url, { size: 20, color: '145AC8', underline: {} })],
          }),
        ],
      }),
    );
  }

  private imageParagraph(dataUrl: string | null, width: number, height: number, label: string): DocxModule.Paragraph {
    if (dataUrl) {
      try {
        return new this.d.Paragraph({
          alignment: this.d.AlignmentType.CENTER,
          spacing: { after: 60 },
          children: [
            new this.d.ImageRun({
              type: imageType(dataUrl),
              data: dataUrl,
              transformation: { width: Math.round(width), height: Math.round(height) },
            }),
          ],
        });
      } catch {
        // fall through to the placeholder
      }
    }
    return new this.d.Paragraph({
      alignment: this.d.AlignmentType.CENTER,
      spacing: { before: 120, after: 120 },
      children: [this.run(`[${label}]`, { size: 16, color: GRAY })],
    });
  }

  figure(spec: FigureSpec): void {
    const aspect = spec.aspect > 0 ? spec.aspect : 0.75;
    const maxH = Math.min(mmToPx(spec.maxHeightMm ?? FIGURE_MAX_H_MM), BODY_MAX_H_PX);
    let w = CONTENT_PX;
    let h = w * aspect;
    if (h > maxH) {
      h = maxH;
      w = h / aspect;
    }
    const title = figureTitle(spec);
    if (title) this.subheading(title);
    this.children.push(this.imageParagraph(spec.image, w, h, 'Image unavailable'));
    this.smallText(spec.details);
    if (spec.note?.trim()) this.notes([{ label: 'Note', text: spec.note }]);
  }

  imagePair(spec: ImagePairSpec): void {
    const colPx = (CONTENT_PX - 12) / 2;
    const imgH = colPx * 0.75;
    this.subheading(`${spec.index}. ${spec.caption || 'Imaging pair'}`);
    const cell = (label: string, image: string | null) =>
      new this.d.TableCell({
        width: { size: 50, type: this.d.WidthType.PERCENTAGE },
        borders: {
          top: { style: this.d.BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          bottom: { style: this.d.BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          left: { style: this.d.BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          right: { style: this.d.BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        },
        children: [
          new this.d.Paragraph({ children: [this.run(label, { size: 16, color: GRAY })] }),
          this.imageParagraph(image, colPx, imgH, 'No image'),
        ],
      });
    this.children.push(
      new this.d.Table({
        width: { size: 100, type: this.d.WidthType.PERCENTAGE },
        rows: [new this.d.TableRow({ children: [cell(spec.leftLabel, spec.leftImage), cell(spec.rightLabel, spec.rightImage)] })],
      }),
      new this.d.Paragraph({ spacing: { after: 60 }, children: [] }),
    );
  }

  notes(notes: NoteSpec[]): void {
    for (const n of notes) {
      if (!n.text.trim()) continue;
      // A raw line feed inside a run is not a break in Word: one paragraph per line
      const [first, ...rest] = n.text.split('\n');
      this.children.push(
        new this.d.Paragraph({
          spacing: { after: rest.length ? 0 : 40 },
          children: [this.run(`${n.label}: `, { bold: true, size: 17 }), this.run(first, { size: 17 })],
        }),
        ...rest.map(
          (line, i) =>
            new this.d.Paragraph({
              spacing: { after: i === rest.length - 1 ? 40 : 0 },
              children: [this.run(line, { size: 17 })],
            }),
        ),
      );
    }
  }

  table(cols: TableColumn[], rows: TableCell[][]): void {
    const total = cols.reduce((s, c) => s + c.w, 0) || 1;
    const pct = (c: TableColumn) => Math.round((c.w / total) * 100);
    const headerCell = (c: TableColumn) =>
      new this.d.TableCell({
        width: { size: pct(c), type: this.d.WidthType.PERCENTAGE },
        shading: { fill: ACCENT, type: this.d.ShadingType.CLEAR, color: 'auto' },
        children: [new this.d.Paragraph({ children: [this.run(c.label, { bold: true, size: 16, color: 'FFFFFF' })] })],
      });
    const bodyCell = (c: TableColumn, cell: TableCell) =>
      new this.d.TableCell({
        width: { size: pct(c), type: this.d.WidthType.PERCENTAGE },
        children: cellText(cell)
          .split('\n')
          .map((line) => new this.d.Paragraph({ children: [this.run(line, { size: 15 })] })),
      });
    this.children.push(
      new this.d.Table({
        width: { size: 100, type: this.d.WidthType.PERCENTAGE },
        rows: [
          new this.d.TableRow({ tableHeader: true, children: cols.map(headerCell) }),
          ...rows.map((cells) => new this.d.TableRow({ children: cells.map((cell, i) => bodyCell(cols[i], cell)) })),
        ],
      }),
      new this.d.Paragraph({ spacing: { after: 120 }, children: [] }),
    );
  }

  space(): void {
    this.children.push(new this.d.Paragraph({ spacing: { after: 60 }, children: [] }));
  }

  footers(left: string): void {
    this.footerLeft = left;
  }

  async finish(): Promise<Uint8Array> {
    const d = this.d;
    const footer = new d.Footer({
      children: [
        new d.Paragraph({
          alignment: d.AlignmentType.RIGHT,
          children: [
            ...(this.footerLeft.trim() ? [this.run(`${this.footerLeft}     `, { size: 16, color: GRAY })] : []),
            new d.TextRun({ children: ['Page ', d.PageNumber.CURRENT, ' of ', d.PageNumber.TOTAL_PAGES], size: 16, color: GRAY }),
          ],
        }),
      ],
    });
    const doc = new d.Document({
      creator: 'Open DroneLog',
      styles: { default: { document: { run: { font: 'Arial', size: 20 } } } },
      sections: [
        {
          properties: {
            page: {
              size: { width: PAGE.width, height: PAGE.height },
              margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
            },
          },
          footers: { default: footer },
          children: this.children,
        },
      ],
    });
    const blob = await d.Packer.toBlob(doc);
    return new Uint8Array(await blob.arrayBuffer());
  }
}

export async function createDocxWriter(): Promise<DocxWriter> {
  const docx = await import('docx');
  return new DocxWriter(docx);
}
