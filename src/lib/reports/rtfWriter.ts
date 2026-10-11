/**
 * Minimal RTF writer shared by every report kind (opens in Word/LibreOffice,
 * images embedded as PNG/JPEG picts). Same role as PdfWriter: builders only
 * compose sections.
 */

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

export class RtfWriter {
  private readonly parts: string[] = [];
  private sectionNo = 1;

  constructor() {
    // Color table: 1 = accent blue, 2 = warning red, 3 = gray
    this.parts.push(
      '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}{\\f1 Courier New;}}' +
        '{\\colortbl;\\red20\\green60\\blue110;\\red200\\green60\\blue40;\\red110\\green110\\blue110;}',
    );
  }

  title(text: string, subtitle: string): void {
    this.parts.push(`{\\pard\\sa200\\b\\fs40\\cf1 ${rtfEscape(text)}\\par}`);
    this.parts.push(`{\\pard\\sa200\\fs16\\cf3 ${rtfEscape(subtitle)}\\par}`);
  }

  sectionHeading(title: string): void {
    this.heading(`${this.sectionNo++}. ${title}`);
  }

  heading(text: string): void {
    this.parts.push(`{\\pard\\sb240\\sa120\\b\\fs28\\cf1 ${rtfEscape(text)}\\par}`);
  }

  sub(text: string): void {
    this.parts.push(`{\\pard\\sb120\\sa60\\b\\fs22 ${rtfEscape(text)}\\par}`);
  }

  para(text: string): void {
    if (!text.trim()) return;
    this.parts.push(`{\\pard\\sa120\\fs20 ${rtfEscape(text)}\\par}`);
  }

  kv(key: string, value: string): void {
    this.parts.push(`{\\pard\\sa60\\fs20{\\b ${rtfEscape(key)}: }${rtfEscape(value || '—')}\\par}`);
  }

  /** Small gray line (captions, provenance). */
  gray(text: string): void {
    this.parts.push(`{\\pard\\sa120\\fs16\\cf3 ${rtfEscape(text)}\\par}`);
  }

  /** Embedded image paragraph. */
  pict(dataUrl: string, widthTwips: number, heightTwips: number): void {
    this.parts.push(`{\\pard\\sa60 ${dataUrlToRtfPict(dataUrl, widthTwips, heightTwips)}\\par}`);
  }

  /** Escape hatch for layouts the helpers do not cover (already-escaped RTF). */
  raw(rtf: string): void {
    this.parts.push(rtf);
  }

  finish(): string {
    return [...this.parts, '}'].join('\n');
  }
}
