/**
 * Export-time content resolution shared by the report builders: asset bytes
 * to data URLs and the embedded orthomosaic.
 */

import * as thermalApi from '@/lib/thermalApi';
import { hasDisplayableImage, parseMetashapeMeta, previewMimeType } from '@/types/thermal';
import type { ThermalAsset } from '@/types/thermal';
import type { OrthoExtras } from './common';

export function bytesToDataUrl(buf: ArrayBuffer, mime: string): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

/** The asset's displayable file as a data URL (GeoTIFFs via their PNG preview). */
export async function readAssetDataUrl(asset: ThermalAsset): Promise<string | null> {
  if (!hasDisplayableImage(asset)) return null;
  try {
    const buf = await thermalApi.readThermalAssetPreview(asset.id);
    return bytesToDataUrl(buf, previewMimeType(asset));
  } catch {
    return null;
  }
}

/** Resolve the embedded orthomosaic (best-effort; missing → empty extras). */
export async function collectOrthoExtras(
  orthoAssetId: number | null,
  assets: ThermalAsset[],
): Promise<OrthoExtras> {
  const extras: OrthoExtras = {};
  const orthoAsset = orthoAssetId == null ? null : assets.find((a) => a.id === orthoAssetId);
  if (!orthoAsset) return extras;
  try {
    // Orthomosaics render via their PNG preview
    const buf = await thermalApi.readThermalAssetPreview(orthoAsset.id);
    extras.orthoDataUrl = bytesToDataUrl(buf, 'image/png');
    const m = parseMetashapeMeta(orthoAsset);
    if (m?.width && m?.height) {
      // height/width — used to embed at the true aspect ratio
      extras.orthoAspect = m.height / m.width;
    }
    extras.orthoLabel = [
      orthoAsset.fileName,
      m?.width ? `${m.width}×${m.height} px` : null,
      m?.crs ?? null,
    ]
      .filter(Boolean)
      .join(' · ');
  } catch {
    // ortho embed is best-effort
  }
  return extras;
}
