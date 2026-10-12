/**
 * The document model every report kind is rendered against. A report kind
 * writes its sections once with these primitives; each output format (PDF,
 * Word, RTF, and the editable HTML preview) implements them. Adding a format
 * means one new writer; adding a section means calling these in the kind's
 * renderer.
 *
 * `EditRef`s name the report field a piece of text comes from. Only the HTML
 * preview uses them (to make that text editable in place); the file writers
 * ignore them.
 */

export interface EditRef {
  /** Dotted path into the report (`anomalies.2.finding`), or a routed path
   *  such as `assetNote.<assetId>` / `figures.<i>.caption`. */
  path: string;
  /** Single-line field: Enter commits instead of inserting a line break. */
  single?: boolean;
}

export interface TextOptions {
  edit?: EditRef;
  /** Printed by the file writers when the text is blank ("No action plan
   *  recorded."). The preview shows it as the empty field's hint instead. */
  placeholder?: string;
  /** Hint for an empty editable field in the preview only — never printed. */
  hint?: string;
  /** Font size in points (default 10). */
  size?: number;
}

export interface KvOptions {
  /** Small label/value row (8 pt, narrow label column) for secondary data. */
  compact?: boolean;
}

export interface TableColumn {
  label: string;
  /** Width in mm of the 178 mm A4 content width; other formats scale it. */
  w: number;
}

export type TableCell = string | { text: string; edit?: EditRef };

export interface FigureSpec {
  /** 1-based figure number; omitted for unnumbered images (the orthomosaic). */
  index?: number;
  /** PNG/JPEG data URL, or null for a placeholder. */
  image: string | null;
  /** height / width. */
  aspect: number;
  /** Tallest the image may print (mm on A4); default fits two figures per page. */
  maxHeightMm?: number;
  caption: string;
  captionEdit?: EditRef;
  /** Provenance line (file, capture time, position…). */
  details: string;
  note?: string | null;
  noteEdit?: EditRef;
}

export interface ImagePairSpec {
  /** 1-based pair number. */
  index: number;
  caption: string;
  captionEdit?: EditRef;
  leftLabel: string;
  leftImage: string | null;
  rightLabel: string;
  rightImage: string | null;
  /** Provenance line under the pair (picture names, capture time, position). */
  details?: string;
}

export interface NoteSpec {
  label: string;
  text: string;
  edit?: EditRef;
}

export const CONTENT_WIDTH_MM = 178;

export interface ReportWriter {
  /** True for the preview: renderers then emit empty editable fields too. */
  readonly editable: boolean;

  title(text: string, subtitle: string): void;
  /** Auto-numbered section heading. */
  sectionHeading(title: string): void;
  subheading(text: string, edit?: EditRef): void;
  /** Body text. Blank text is skipped unless a placeholder is given. */
  paragraph(text: string, options?: TextOptions): void;
  /** Compact black detail lines (flight data, deliverables). */
  detail(text: string, edit?: EditRef): void;
  /** Small gray text (provenance, captions). */
  smallText(text: string, edit?: EditRef): void;
  /** Bold label line introducing detail paragraphs ("A-01 — Finding"). */
  boldLine(text: string): void;
  kv(key: string, value: string, edit?: EditRef, options?: KvOptions): void;
  link(url: string, edit?: EditRef): void;
  figure(spec: FigureSpec): void;
  imagePair(spec: ImagePairSpec): void;
  /** "Label: text" lines under an image (per-picture notes). */
  notes(notes: NoteSpec[]): void;
  table(cols: TableColumn[], rows: TableCell[][]): void;
  space(mm?: number): void;
  /** Page footers ("Page n of N" plus a running text). */
  footers(left: string): void;
}

export function cellText(cell: TableCell): string {
  return typeof cell === 'string' ? cell : cell.text;
}

/** Default figure height cap (mm): two 4:3 figures per A4 page. */
export const FIGURE_MAX_H_MM = 92;

/** "Figure 3. Caption" for numbered figures, the bare caption otherwise ('' = no title line). */
export function figureTitle(spec: FigureSpec): string {
  return spec.index != null ? `Figure ${spec.index}. ${spec.caption.trim() || 'Untitled'}` : spec.caption.trim();
}
