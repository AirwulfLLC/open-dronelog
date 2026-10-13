/**
 * Export-time rendering of radiometric pictures for the thermal report: the
 * temperature matrix through the pair's palette and span, with the picture's
 * stored annotations drawn on top. Every pair renders the same way, whether
 * or not its picture is the one open in the studio.
 */

import * as thermalApi from '@/lib/thermalApi';
import { PALETTES, renderTempsToImageData } from '@/lib/thermalPalettes';
import { drawAnnotationsToCanvas } from '@/components/thermal/annotationUtils';
import type { Annotation, MeasureOverrides, ThermalAsset } from '@/types/thermal';

export interface ThermalRenderOptions {
  paletteKey?: string;
  spanLow?: number | null;
  spanHigh?: number | null;
}

export interface RenderedThermal {
  /** PNG (or JPEG for large rasters) data URL. */
  dataUrl: string;
  /** The span actually mapped to the palette (the picture's min/max when auto). */
  low: number;
  high: number;
  paletteLabel: string;
}

/** Longest edge of an exported picture (px): a vegetation-index raster can be
 *  a whole orthomosaic, which would otherwise land in the files at full size. */
const MAX_EXPORT_EDGE = 2000;
/** Above this many output pixels the picture is written as JPEG; thermal
 *  frames (640×512) stay lossless PNG. */
const PNG_MAX_PIXELS = 1_000_000;

export function paletteLabel(key: string | undefined): string {
  return (PALETTES.find((p) => p.key === key) ?? PALETTES[0]).label;
}

export async function renderRadiometricAsset(
  asset: ThermalAsset,
  opts: ThermalRenderOptions,
  annotations: Annotation[],
  overrides?: MeasureOverrides,
): Promise<RenderedThermal | null> {
  const matrix = await thermalApi.getTempMatrix(asset.id, overrides);
  const { width: w, height: h, temps } = matrix;
  if (w <= 0 || h <= 0) return null;
  const paletteKey = PALETTES.some((p) => p.key === opts.paletteKey) ? (opts.paletteKey as string) : PALETTES[0].key;

  // Resolve the span the picture is printed with, so it can be stated. A
  // missing end takes the picture's own extreme; a span that ends up inverted
  // or flat (manual values, or one end beyond the picture's range) is auto.
  let low = opts.spanLow ?? null;
  let high = opts.spanHigh ?? null;
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < temps.length; i++) {
    const t = temps[i];
    if (t < mn) mn = t;
    if (t > mx) mx = t;
  }
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) return null; // no measurable pixels
  if (low == null) low = mn;
  if (high == null) high = mx;
  if (!(high > low)) {
    low = mn;
    high = mx;
  }

  const img = renderTempsToImageData(temps, w, h, { paletteKey, spanLow: low, spanHigh: high });
  // Nodata pixels of index rasters are NaN: leave them transparent, as the
  // stored preview does, instead of painting them as the lowest value
  for (let i = 0; i < temps.length; i++) {
    if (Number.isNaN(temps[i])) img.data[i * 4 + 3] = 0;
  }
  const full = document.createElement('canvas');
  full.width = w;
  full.height = h;
  const fullCtx = full.getContext('2d');
  if (!fullCtx) return null;
  fullCtx.putImageData(img, 0, 0);

  const scale = Math.min(1, MAX_EXPORT_EDGE / Math.max(w, h));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  const asJpeg = out.width * out.height > PNG_MAX_PIXELS;
  if (asJpeg) {
    // JPEG has no transparency: nodata reads as paper, not black
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
  }
  ctx.drawImage(full, 0, 0, out.width, out.height);
  // Annotations are stored in source-pixel coordinates
  ctx.save();
  ctx.scale(scale, scale);
  drawAnnotationsToCanvas(ctx, annotations);
  ctx.restore();
  return {
    dataUrl: asJpeg ? out.toDataURL('image/jpeg', 0.88) : out.toDataURL('image/png'),
    low,
    high,
    paletteLabel: paletteLabel(paletteKey),
  };
}
