/**
 * HTML implementation of ReportWriter for the in-app preview. It mirrors the
 * PDF layout on a white A4-wide page and marks every text that came from a
 * report field as editable in place (`contenteditable` + `data-edit` path),
 * so the preview doubles as a last-pass editor before export.
 */

import {
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

/** CSS px per mm at 96 dpi. */
const PX_PER_MM = 3.78;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Attributes that make an element an in-place editor for `edit`. */
function editableAttrs(edit: EditRef | undefined, placeholder?: string): string {
  if (!edit) return '';
  return (
    ` contenteditable="true" spellcheck="true" data-edit="${escapeHtml(edit.path)}"` +
    (edit.single ? ' data-single="1"' : '') +
    (placeholder ? ` data-placeholder="${escapeHtml(placeholder)}"` : '')
  );
}

export const PREVIEW_STYLES = `
.rpt { font-family: Helvetica, Arial, sans-serif; color: #111; background: #fff; width: 794px; max-width: 100%;
       box-sizing: border-box; padding: 60px 60px 72px; margin: 0 auto; line-height: 1.35; }
.rpt h1 { font-size: 26px; color: #143c6e; margin: 0 0 4px; }
.rpt .sub { font-size: 12px; color: #6e6e6e; margin: 0 0 20px; }
.rpt h2 { font-size: 17px; color: #143c6e; border-bottom: 1.5px solid #143c6e; padding-bottom: 3px; margin: 26px 0 12px; }
.rpt h3 { font-size: 13.5px; margin: 12px 0 5px; }
.rpt p { font-size: 13px; margin: 0 0 8px; white-space: pre-wrap; }
.rpt .detail { font-size: 11.5px; margin: 0 0 3px; white-space: pre-wrap; }
.rpt .small { font-size: 11px; color: #6e6e6e; margin: 0 0 8px; white-space: pre-wrap; }
.rpt .bold { font-size: 12px; font-weight: 700; margin: 8px 0 2px; }
.rpt .kv { font-size: 13px; margin: 0 0 6px; display: flex; gap: 8px; }
.rpt .kv b { flex: 0 0 180px; }
.rpt .kv span { flex: 1; white-space: pre-wrap; }
.rpt .kv.compact { font-size: 11px; margin-bottom: 3px; }
.rpt .kv.compact b { flex-basis: 120px; }
.rpt a { color: #145ac8; word-break: break-all; }
.rpt figure { margin: 0 0 20px; }
.rpt figure img { display: block; max-width: 100%; margin: 4px auto; }
.rpt .ph { border: 1px solid #b4b4b4; color: #969696; font-size: 11px; display: flex; align-items: center;
           justify-content: center; height: 220px; margin: 4px 0; }
.rpt .pair { display: flex; gap: 12px; margin: 2px 0 10px; }
.rpt .pair > div { flex: 1; min-width: 0; }
.rpt .pair .lbl { font-size: 11px; color: #6e6e6e; margin-bottom: 2px; }
.rpt .pair img { width: 100%; display: block; }
.rpt .pair .ph { height: 180px; }
.rpt .note { font-size: 11.5px; margin: 0 0 4px; white-space: pre-wrap; }
.rpt table { width: 100%; border-collapse: collapse; font-size: 11px; margin: 0 0 12px; }
.rpt th { background: #143c6e; color: #fff; text-align: left; padding: 4px 5px; font-weight: 700; }
.rpt td { border-bottom: 1px solid #d2d2d2; padding: 4px 5px; vertical-align: top; white-space: pre-wrap; }
.rpt .foot { margin-top: 36px; padding-top: 8px; border-top: 1px solid #ddd; font-size: 11px; color: #8c8c8c;
             display: flex; justify-content: space-between; }
.rpt [data-edit] { outline: 1px dashed transparent; outline-offset: 2px; border-radius: 2px; min-width: 2em;
                   transition: outline-color .15s, background-color .15s; }
.rpt [data-edit]:hover { outline-color: #38bdf8; }
.rpt [data-edit]:focus { outline: 2px solid #0ea5e9; background: #f0f9ff; }
.rpt [data-edit]:empty::before { content: attr(data-placeholder); color: #9ca3af; font-style: italic; }
`;

export class HtmlWriter implements ReportWriter {
  readonly editable = true;
  private readonly parts: string[] = [];
  private sectionNo = 1;
  private footerLeft = '';

  title(text: string, subtitle: string): void {
    this.parts.push(`<h1>${escapeHtml(text)}</h1><p class="sub">${escapeHtml(subtitle)}</p>`);
  }

  sectionHeading(title: string): void {
    this.parts.push(`<h2>${this.sectionNo++}. ${escapeHtml(title)}</h2>`);
  }

  subheading(text: string, edit?: EditRef): void {
    this.parts.push(`<h3${editableAttrs(edit)}>${escapeHtml(text)}</h3>`);
  }

  paragraph(text: string, options?: TextOptions): void {
    const style = options?.size && options.size !== 10 ? ` style="font-size:${(options.size * 1.3).toFixed(1)}px"` : '';
    if (!text.trim() && !options?.edit) {
      if (options?.placeholder) this.parts.push(`<p${style}>${escapeHtml(options.placeholder)}</p>`);
      return;
    }
    const hint = options?.hint ?? options?.placeholder;
    this.parts.push(`<p${style}${editableAttrs(options?.edit, hint)}>${escapeHtml(text)}</p>`);
  }

  detail(text: string, edit?: EditRef): void {
    if (!text.trim() && !edit) return;
    this.parts.push(`<p class="detail"${editableAttrs(edit)}>${escapeHtml(text)}</p>`);
  }

  smallText(text: string, edit?: EditRef): void {
    if (!text.trim() && !edit) return;
    this.parts.push(`<p class="small"${editableAttrs(edit)}>${escapeHtml(text)}</p>`);
  }

  boldLine(text: string): void {
    this.parts.push(`<p class="bold">${escapeHtml(text)}</p>`);
  }

  kv(key: string, value: string, edit?: EditRef, options?: KvOptions): void {
    const single = edit ? { ...edit, single: edit.single ?? true } : undefined;
    const cls = options?.compact ? 'kv compact' : 'kv';
    this.parts.push(
      `<div class="${cls}"><b>${escapeHtml(key)}:</b><span${editableAttrs(single, '—')}>${escapeHtml(value)}</span></div>`,
    );
  }

  link(url: string, edit?: EditRef): void {
    if (!url.trim() && !edit) return;
    const single = edit ? { ...edit, single: true } : undefined;
    this.parts.push(
      edit
        ? `<p><span${editableAttrs(single, 'https://…')}>${escapeHtml(url)}</span></p>`
        : `<p><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></p>`,
    );
  }

  private img(image: string | null, label: string, maxHeightMm?: number): string {
    if (!image) return `<div class="ph">${escapeHtml(label)}</div>`;
    const style = maxHeightMm ? ` style="max-height:${Math.round(maxHeightMm * PX_PER_MM)}px"` : '';
    return `<img src="${image}" alt=""${style}>`;
  }

  figure(spec: FigureSpec): void {
    const cap = spec.captionEdit ? { ...spec.captionEdit, single: true } : undefined;
    const titleHtml =
      spec.index != null
        ? `<h3><b>Figure ${spec.index}.</b> <span${editableAttrs(cap, 'Untitled')}>${escapeHtml(spec.caption)}</span></h3>`
        : figureTitle(spec)
          ? `<h3${editableAttrs(cap)}>${escapeHtml(spec.caption)}</h3>`
          : '';
    const noteHtml =
      spec.noteEdit || spec.note?.trim()
        ? `<p class="note"><b>Note:</b> <span${editableAttrs(spec.noteEdit, 'add a note for this picture')}>${escapeHtml(spec.note ?? '')}</span></p>`
        : '';
    this.parts.push(
      `<figure>${titleHtml}` +
        this.img(spec.image, 'Image unavailable', spec.maxHeightMm ?? FIGURE_MAX_H_MM) +
        `<p class="small">${escapeHtml(spec.details)}</p>${noteHtml}</figure>`,
    );
  }

  imagePair(spec: ImagePairSpec): void {
    const cap = spec.captionEdit ? { ...spec.captionEdit, single: true } : undefined;
    this.parts.push(
      `<h3><b>${spec.index}.</b> <span${editableAttrs(cap, 'Imaging pair')}>${escapeHtml(spec.caption)}</span></h3>` +
        `<div class="pair"><div><div class="lbl">${escapeHtml(spec.leftLabel)}</div>${this.img(spec.leftImage, 'No image')}</div>` +
        `<div><div class="lbl">${escapeHtml(spec.rightLabel)}</div>${this.img(spec.rightImage, 'No image')}</div></div>` +
        (spec.details?.trim() ? `<p class="small">${escapeHtml(spec.details)}</p>` : ''),
    );
  }

  notes(notes: NoteSpec[]): void {
    for (const n of notes) {
      if (!n.text.trim() && !n.edit) continue;
      this.parts.push(
        `<p class="note"><b>${escapeHtml(n.label)}:</b> <span${editableAttrs(n.edit, 'add a note')}>${escapeHtml(n.text)}</span></p>`,
      );
    }
  }

  table(cols: TableColumn[], rows: TableCell[][]): void {
    const total = cols.reduce((s, c) => s + c.w, 0) || 1;
    const head = cols
      .map((c) => `<th style="width:${((c.w / total) * 100).toFixed(1)}%">${escapeHtml(c.label)}</th>`)
      .join('');
    const body = rows
      .map(
        (cells) =>
          '<tr>' +
          cells
            .map((cell) => {
              const edit = typeof cell === 'string' ? undefined : cell.edit;
              return `<td${editableAttrs(edit)}>${escapeHtml(cellText(cell))}</td>`;
            })
            .join('') +
          '</tr>',
      )
      .join('');
    this.parts.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
  }

  space(): void {
    this.parts.push('<div style="height:6px"></div>');
  }

  footers(left: string): void {
    this.footerLeft = left;
  }

  finish(): string {
    return (
      `<div class="rpt">${this.parts.join('')}` +
      `<div class="foot"><span>${escapeHtml(this.footerLeft)}</span><span>Page numbers appear in the exported file</span></div></div>`
    );
  }
}
