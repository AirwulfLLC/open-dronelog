/**
 * AI drafting of report sections: the model writes a section's prose from
 * the facts the user already entered in the builder. Text-only — no images —
 * through whichever provider/key is configured in Settings.
 */

import { thermalAiGenerateText } from '@/lib/thermalApi';
import { REPORT_PUBLISHER } from './common';

export function aiSystemPrompt(workflow: string): string {
  return (
    `You write sections of professional drone ${workflow} reports for ${REPORT_PUBLISHER}. ` +
    'Write clear, formal inspection-report prose in the third person. Use only the facts ' +
    'provided: never invent measurements, dates, locations, equipment or defects — if something ' +
    'is not in the facts, leave it out or state that it was not recorded. Plain text only: no ' +
    'markdown, no headings, no bullet or asterisk symbols unless the instruction asks for a ' +
    'numbered list. Be concise.'
  );
}

/** Draft one section; returns the model's reply trimmed. */
export async function draftSection(workflow: string, instruction: string, facts: unknown): Promise<string> {
  const user = `${instruction}\n\nFacts (JSON):\n${JSON.stringify(facts, null, 2)}`;
  const text = await thermalAiGenerateText(aiSystemPrompt(workflow), user);
  return text.trim();
}

/** Pull a JSON value out of a reply that may wrap it in a code fence or prose. */
export function parseAiJson<T>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  // Try the whole body, then the outermost array span, then the outermost
  // object span — prose around the JSON may itself contain brackets
  const candidates = [body];
  for (const [open, close] of [
    ['[', ']'],
    ['{', '}'],
  ]) {
    const start = body.indexOf(open);
    const end = body.lastIndexOf(close);
    if (start >= 0 && end > start) candidates.push(body.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // next candidate
    }
  }
  return null;
}

/** A provided, non-blank string; blank or missing values are "not provided"
 *  so a model that returns "" never wipes the user's text. */
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Merge per-entry text from a model's JSON array into entries matched by id.
 *  Only the listed string fields are taken; entries the model skipped stay. */
export function mergeById<E extends { id: string }, K extends keyof E & string>(
  entries: E[],
  rows: unknown,
  fields: K[],
): { entries: E[]; changed: boolean } {
  if (!Array.isArray(rows)) return { entries, changed: false };
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string') {
      byId.set((row as { id: string }).id, row as Record<string, unknown>);
    }
  }
  let changed = false;
  const merged = entries.map((entry) => {
    const row = byId.get(entry.id);
    if (!row) return entry;
    const next = { ...entry };
    for (const f of fields) {
      const value = str(row[f]);
      if (value != null) {
        (next as Record<string, unknown>)[f] = value;
        changed = true;
      }
    }
    return next;
  });
  return { entries: merged, changed };
}
