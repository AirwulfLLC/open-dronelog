/**
 * Administrative details that rarely change between a thermographer's
 * reports — name, credentials, contact and the camera used — remembered per
 * profile from the last saved or exported report and offered to new ones.
 */

import { getSettingValue, setSettingValue } from '@/lib/api';
import type { ThermalReport } from '@/types/thermal';

export const THERMAL_REPORT_DEFAULTS_KEY = 'thermal_report_defaults';

const FIELDS = [
  'inspectorName',
  'inspectorCredentials',
  'inspectorContact',
  'cameraMake',
  'cameraModel',
  'cameraSerial',
] as const;

export type ThermalReportDefaults = Partial<Pick<ThermalReport, (typeof FIELDS)[number]>>;

let cached: ThermalReportDefaults = {};
let lastStored: string | null = null;

function pick(source: Record<string, unknown>): ThermalReportDefaults {
  const out: ThermalReportDefaults = {};
  for (const f of FIELDS) {
    const v = source[f];
    if (typeof v === 'string' && v.trim()) out[f] = v;
  }
  return out;
}

/** Read the stored defaults into memory (the studio does this on mount, so a
 *  new report can start from them synchronously). */
export async function loadThermalReportDefaults(): Promise<void> {
  try {
    const json = await getSettingValue(THERMAL_REPORT_DEFAULTS_KEY);
    cached = json ? pick(JSON.parse(json) as Record<string, unknown>) : {};
    lastStored = json;
  } catch {
    // defaults are a convenience; a blank report is fine
  }
}

export function thermalReportDefaults(): ThermalReportDefaults {
  return cached;
}

/** Remember the report's administrative details for the next new report. */
export function rememberThermalReportDefaults(report: ThermalReport): void {
  const next = pick(report as unknown as Record<string, unknown>);
  const json = JSON.stringify(next);
  if (json === lastStored) return;
  cached = next;
  lastStored = json;
  void setSettingValue(THERMAL_REPORT_DEFAULTS_KEY, json).catch((e) => {
    console.warn('Could not store the thermal report defaults:', e);
  });
}
