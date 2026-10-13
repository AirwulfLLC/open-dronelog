/**
 * The survey's deliverables as structured rows — orthomosaic, point cloud,
 * textured mesh (core visual products) and DEM/DSM, DTM, contours
 * (topographical products) — each with a status, specification and link.
 * One factory, two sections: each shows the kinds it owns. Core rows can be
 * seeded from the imported Metashape files.
 */

import { useThermalStore } from '@/stores/thermalStore';
import {
  DELIVERABLE_KIND_LABELS,
  parseMetashapeMeta,
  type DeliverableEntry,
  type DeliverableKind,
  type DeliverableStatus,
  type PhotogrammetryReport,
  type ThermalAsset,
} from '@/types/thermal';
import { inputCls, labelCls, nextEntryId, smallBtnCls, type SectionProps } from '../types';

const fmtSize = (b?: number) =>
  b == null ? null : b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

/** A GeoTIFF is an orthomosaic unless its name says it is an elevation
 *  product — the importer cannot tell them apart, the file name usually can. */
function geotiffKind(fileName: string): DeliverableKind {
  const n = fileName.toLowerCase();
  if (/contour/.test(n)) return 'contours';
  if (/\b(dtm|terrain)\b|_dtm|dtm_/.test(n)) return 'dtm';
  if (/\b(dem|dsm|elev|elevation|height|surface)\b|_(dem|dsm)|(dem|dsm)_/.test(n)) return 'dsm';
  return 'orthomosaic';
}

/** The deliverable an imported Metashape file represents, or null for files
 *  that are inputs rather than products (camera files, processing report). */
export function deliverableFromFile(asset: ThermalAsset): Omit<DeliverableEntry, 'id'> | null {
  const m = parseMetashapeMeta(asset);
  if (!m) return null;
  const ext = asset.fileName.split('.').pop()?.toLowerCase() ?? '';
  const size = fmtSize(m.sizeBytes);
  const base = { status: 'produced' as DeliverableStatus, title: '', link: '' };
  switch (m.kind) {
    case 'orthomosaic':
    case 'multispectral':
      return {
        ...base,
        kind: m.kind === 'multispectral' ? 'orthomosaic' : geotiffKind(asset.fileName),
        details: [asset.fileName, m.width ? `${m.width}×${m.height} px` : null, m.bands ? `${m.bands} bands` : null, m.crs ?? null, size]
          .filter(Boolean)
          .join(' · '),
      };
    case 'point_cloud':
      return {
        ...base,
        kind: ext === 'obj' ? 'mesh' : 'point_cloud',
        details: [asset.fileName, ext.toUpperCase(), size].filter(Boolean).join(' · '),
      };
    case 'vegetation_index':
      return {
        ...base,
        kind: 'other',
        title: `Vegetation index${m.indexName ? ` (${m.indexName})` : ''}`,
        details: [asset.fileName, m.width ? `${m.width}×${m.height} px` : null].filter(Boolean).join(' · '),
      };
    case 'map_overlay':
      return {
        ...base,
        kind: 'other',
        title: `Map overlay (${(m.format ?? ext).toUpperCase()})`,
        details: [asset.fileName, size].filter(Boolean).join(' · '),
      };
    default:
      return null;
  }
}

export function makeDeliverablesSection(kinds: DeliverableKind[], options: { seedFromFiles?: boolean; emptyHint: string }) {
  const owns = (d: DeliverableEntry) => kinds.includes(d.kind);

  function Actions({ report, update, setNotice }: SectionProps<PhotogrammetryReport>) {
    const assets = useThermalStore((s) => s.assets);
    const add = (kind: DeliverableKind) =>
      update({
        deliverables: [
          ...report.deliverables,
          { id: nextEntryId('dl'), kind, status: 'produced', title: '', details: '', link: '' },
        ],
      });

    const seed = () => {
      // Ticked files first; the whole Metashape library before any are ticked.
      // One row per file (two orthomosaics are two products); a file already
      // named in a row is skipped.
      let files = assets.filter((a) => a.source === 'metashape' && report.outputAssetIds.includes(a.id));
      if (files.length === 0) files = assets.filter((a) => a.source === 'metashape');
      const mentioned = (name: string) => report.deliverables.some((d) => d.details.includes(name));
      const rows: DeliverableEntry[] = [];
      let skipped = 0;
      for (const f of files) {
        const d = deliverableFromFile(f);
        if (!d || !kinds.includes(d.kind)) continue;
        if (mentioned(f.fileName)) {
          skipped += 1;
          continue;
        }
        rows.push({ id: nextEntryId('dl'), ...d });
      }
      if (rows.length === 0) {
        setNotice(
          files.length === 0
            ? 'Import the Metashape deliverables (orthomosaic, point cloud, model…) into the library first.'
            : skipped > 0
              ? 'Every imported file of this kind already has a row.'
              : 'None of the imported files is a product of this kind (GeoTIFFs named dem/dsm/dtm/contour count as elevation data).',
        );
        return;
      }
      update({ deliverables: [...report.deliverables, ...rows] });
      setNotice(`Added ${rows.length} deliverable(s) from the imported files — check each kind (a DEM GeoTIFF is told from an orthomosaic by its file name).`);
    };

    return (
      <div className="flex gap-1.5 items-center">
        <select
          className="px-1.5 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white text-[11px]"
          value=""
          onChange={(e) => {
            if (e.target.value) add(e.target.value as DeliverableKind);
          }}
          title="Add a deliverable"
        >
          <option value="">+ Add…</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {DELIVERABLE_KIND_LABELS[k]}
            </option>
          ))}
        </select>
        {options.seedFromFiles && (
          <button onClick={seed} className={smallBtnCls} title="One row per imported Metashape product">
            ⚡ From imported files
          </button>
        )}
      </div>
    );
  }
  Actions.displayName = 'DeliverablesActions';

  function Component({ report, update }: SectionProps<PhotogrammetryReport>) {
    const rows = report.deliverables.filter(owns);
    const updateRow = (id: string, patch: Partial<DeliverableEntry>) =>
      update({ deliverables: report.deliverables.map((d) => (d.id === id ? { ...d, ...patch } : d)) });

    return (
      <div className="space-y-2">
        {rows.length === 0 && <p className="text-[11px] text-gray-500">{options.emptyHint}</p>}
        {rows.map((d) => (
          <div key={d.id} className="p-2.5 rounded-lg bg-gray-800/50 border border-gray-700">
            <div className="flex items-center gap-2 mb-2">
              <select
                className="px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white"
                value={d.kind}
                onChange={(e) => updateRow(d.id, { kind: e.target.value as DeliverableKind })}
              >
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {DELIVERABLE_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
              {d.kind === 'other' && (
                <input
                  className={`${inputCls} flex-1`}
                  value={d.title}
                  onChange={(e) => updateRow(d.id, { title: e.target.value })}
                  placeholder="Deliverable name"
                />
              )}
              <select
                className="px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white"
                value={d.status}
                onChange={(e) => updateRow(d.id, { status: e.target.value as DeliverableStatus })}
              >
                <option value="produced">Produced</option>
                <option value="not_produced">Not produced</option>
              </select>
              <button
                onClick={() => update({ deliverables: report.deliverables.filter((x) => x.id !== d.id) })}
                className="ml-auto text-gray-500 hover:text-red-400 text-xs"
                title="Remove"
              >
                ✕
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>Specification / details</label>
                <input
                  className={inputCls}
                  value={d.details}
                  onChange={(e) => updateRow(d.id, { details: e.target.value })}
                  placeholder={
                    d.kind === 'point_cloud'
                      ? '48.2 M points, LAZ, classified ground/vegetation'
                      : d.kind === 'mesh'
                        ? '2.1 M faces, 8K textures, OBJ + GLB'
                        : d.kind === 'contours'
                          ? '0.5 m interval, DXF + SHP'
                          : d.kind === 'dsm' || d.kind === 'dtm'
                            ? '5 cm/px GeoTIFF, EPSG:6471'
                            : 'Resolution, format, extent, CRS…'
                  }
                />
              </div>
              <div>
                <label className={labelCls}>Hosted at / delivered as</label>
                <input
                  className={inputCls}
                  value={d.link}
                  onChange={(e) => updateRow(d.id, { link: e.target.value })}
                  placeholder="https://… or 'delivered on USB / cloud folder'"
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }
  Component.displayName = 'DeliverablesSection';

  return { Component, Actions };
}
