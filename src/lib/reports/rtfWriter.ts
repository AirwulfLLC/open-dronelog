/**
 * RTF implementation of ReportWriter (opens in Word/LibreOffice, images
 * embedded as PNG/JPEG picts, tables as \trowd rows).
 */

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

export function rtfEscape(text: string): string {
  let out = '';
  // Iterate UTF-16 code units (not code points): RTF's \uN escape is signed
  // 16-bit, so astral characters must be emitted as their surrogate pair.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch === '\\') out += '\\\\';
    else if (ch === '{') out += '\\{';
    else if (ch === '}') out += '\\}';
    else if (ch === '\n') out += '\\line ';
    else if (code > 127) {
      const signed = code > 32767 ? code - 65536 : code;
      out += `\\u${signed}?`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Byte → two-char hex lookup (hot path for multi-MB embedded images). */
const HEX_LUT = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Convert a PNG/JPEG data URL to an RTF \pict group. */
export function dataUrlToRtfPict(dataUrl: string, widthTwips: number, heightTwips: number): string {
  const [meta, b64] = dataUrl.split(',', 2);
  if (!b64) return '';
  const isPng = meta.includes('image/png');
  const binary = atob(b64);
  const parts: string[] = [];
  for (let i = 0; i < binary.length; i++) {
    parts.push(HEX_LUT[binary.charCodeAt(i)]);
    if (i % 64 === 63) parts.push('\n');
  }
  const type = isPng ? '\\pngblip' : '\\jpegblip';
  return `{\\pict${type}\\picwgoal${widthTwips}\\pichgoal${heightTwips}\n${parts.join('')}}`;
}

/** Fit an image of the given height/width ratio into max width/height (twips). */
export function fitTwips(aspect: number, maxW: number, maxH: number): { w: number; h: number } {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 0.75;
  let w = maxW;
  let h = Math.round(w * a);
  if (h > maxH) {
    h = maxH;
    w = Math.round(h / a);
  }
  return { w, h };
}

const TWIPS_PER_MM = 56.69;
/** A4 with 16 mm margins, like the PDF — the table columns assume its 178 mm text width. */
const PAGE_SETUP = '\\paperw11906\\paperh16838\\margl907\\margr907\\margt907\\margb907';

export class RtfWriter implements ReportWriter {
  readonly editable = false;
  /** Prolog: header, font/color tables, page setup. */
  private readonly prolog: string;
  private readonly parts: string[] = [];
  /** Footer destination — RTF wants it before the section's paragraphs. */
  private footerGroup = '';
  private sectionNo = 1;

  constructor() {
    // Color table: 1 = accent blue, 2 = warning red, 3 = gray, 4 = white
    this.prolog =
      '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}{\\f1 Courier New;}}' +
      '{\\colortbl;\\red20\\green60\\blue110;\\red200\\green60\\blue40;\\red110\\green110\\blue110;\\red255\\green255\\blue255;}' +
      PAGE_SETUP;
  }

  title(text: string, subtitle: string): void {
    this.parts.push(`{\\pard\\sa200\\b\\fs40\\cf1 ${rtfEscape(text)}\\par}`);
    this.parts.push(`{\\pard\\sa200\\fs16\\cf3 ${rtfEscape(subtitle)}\\par}`);
  }

  sectionHeading(title: string): void {
    this.parts.push(`{\\pard\\sb240\\sa120\\b\\fs28\\cf1 ${rtfEscape(`${this.sectionNo++}. ${title}`)}\\par}`);
  }

  subheading(text: string): void {
    this.parts.push(`{\\pard\\sb120\\sa60\\b\\fs22 ${rtfEscape(text)}\\par}`);
  }

  paragraph(text: string, options?: TextOptions): void {
    const body = text.trim() ? text : options?.placeholder ?? '';
    if (!body.trim()) return;
    this.parts.push(`{\\pard\\sa120\\fs${(options?.size ?? 10) * 2} ${rtfEscape(body)}\\par}`);
  }

  detail(text: string): void {
    if (!text.trim()) return;
    this.parts.push(`{\\pard\\sa40\\fs17 ${rtfEscape(text)}\\par}`);
  }

  smallText(text: string): void {
    if (!text.trim()) return;
    this.parts.push(`{\\pard\\sa120\\fs16\\cf3 ${rtfEscape(text)}\\par}`);
  }

  boldLine(text: string): void {
    this.parts.push(`{\\pard\\sb60\\sa20\\b\\fs18 ${rtfEscape(text)}\\par}`);
  }

  kv(key: string, value: string, _edit?: EditRef, options?: KvOptions): void {
    const fs = options?.compact ? 16 : 20;
    this.parts.push(`{\\pard\\sa60\\fs${fs}{\\b ${rtfEscape(key)}: }${rtfEscape(value || '—')}\\par}`);
  }

  link(url: string): void {
    if (!url.trim()) return;
    this.parts.push(`{\\pard\\sa120\\fs20 ${rtfEscape(url)}\\par}`);
  }

  pict(dataUrl: string, widthTwips: number, heightTwips: number): void {
    this.parts.push(`{\\pard\\sa60 ${dataUrlToRtfPict(dataUrl, widthTwips, heightTwips)}\\par}`);
  }

  figure(spec: FigureSpec): void {
    const title = figureTitle(spec);
    if (title) this.subheading(title);
    if (spec.image) {
      // ~16cm wide, height capped like the PDF (never beyond the page body)
      const maxH = Math.round(Math.min(spec.maxHeightMm ?? FIGURE_MAX_H_MM, 240) * TWIPS_PER_MM);
      const { w, h } = fitTwips(spec.aspect, 9072, maxH);
      this.pict(spec.image, w, h);
    } else {
      this.paragraph('(image unavailable)');
    }
    this.smallText(spec.details);
    if (spec.note?.trim()) this.notes([{ label: 'Note', text: spec.note }]);
  }

  imagePair(spec: ImagePairSpec): void {
    this.subheading(`${spec.index}. ${spec.caption || 'Imaging pair'}`);
    // ~7.5cm wide each (4252 twips), 4:3
    const pw = 4252;
    const ph = 3189;
    const left = spec.leftImage ? dataUrlToRtfPict(spec.leftImage, pw, ph) : `(no ${spec.leftLabel.toLowerCase()})`;
    const right = spec.rightImage ? dataUrlToRtfPict(spec.rightImage, pw, ph) : `(no ${spec.rightLabel.toLowerCase()})`;
    this.parts.push(
      `{\\pard\\sa60\\fs18\\cf3 ${rtfEscape(spec.leftLabel)}\\tab\\tab ${rtfEscape(spec.rightLabel)}\\par}`,
    );
    this.parts.push(`{\\pard\\sa120 ${left} ${right}\\par}`);
    if (spec.details?.trim()) this.smallText(spec.details);
  }

  notes(notes: NoteSpec[]): void {
    for (const n of notes) {
      if (!n.text.trim()) continue;
      this.parts.push(`{\\pard\\sa40\\fs17{\\b ${rtfEscape(n.label)}: }${rtfEscape(n.text)}\\par}`);
    }
  }

  table(cols: TableColumn[], rows: TableCell[][]): void {
    const total = cols.reduce((s, c) => s + c.w, 0) || CONTENT_WIDTH_MM;
    const scale = (CONTENT_WIDTH_MM * TWIPS_PER_MM) / total;
    let cum = 0;
    const edges = cols.map((c) => {
      cum += c.w * scale;
      return Math.round(cum);
    });
    const border = '\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10';
    const rowDef = (shaded: boolean) =>
      '\\trowd\\trgaph60\\trpaddl60\\trpaddr60' +
      edges.map((e) => `${border}${shaded ? '\\clcbpat1' : ''}\\cellx${e}`).join('');
    // Each cell is its own group so character formatting (\b, \cf) cannot
    // leak into the following cells and paragraphs
    const header =
      rowDef(true) +
      cols.map((c) => `{\\pard\\intbl\\b\\fs16\\cf4 ${rtfEscape(c.label)}\\cell}`).join('') +
      '\\row';
    this.parts.push(header);
    for (const cells of rows) {
      this.parts.push(
        rowDef(false) +
          cells.map((cell) => `{\\pard\\intbl\\fs16 ${rtfEscape(cellText(cell))}\\cell}`).join('') +
          '\\row',
      );
    }
    this.parts.push('{\\pard\\sa120\\par}');
  }

  space(): void {
    this.parts.push('{\\pard\\sa60\\par}');
  }

  footers(left: string): void {
    const text = left.trim() ? `${rtfEscape(left)}\\tab\\tab ` : '';
    this.footerGroup = `{\\footer\\pard\\qr\\fs16\\cf3 ${text}Page {\\field{\\*\\fldinst PAGE}{\\fldrslt 1}} of {\\field{\\*\\fldinst NUMPAGES}{\\fldrslt 1}}\\par}`;
  }

  finish(): string {
    return [this.prolog, this.footerGroup, ...this.parts, '}'].filter(Boolean).join('\n');
  }
}
