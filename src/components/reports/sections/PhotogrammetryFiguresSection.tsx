/**
 * Survey Imagery — the Photogrammetry tab's ordered figure queue, editable
 * here as well (order, captions, removal). The queue store is the source of
 * truth; the builder snapshots it into the report on save/export.
 */

import { useThermalStore } from '@/stores/thermalStore';
import { usePhotogrammetryStore } from '@/stores/photogrammetryStore';
import { fmtFrameTime } from '@/lib/photogrammetryExport';
import type { PhotogrammetryReport } from '@/types/thermal';
import { inputCls, type SectionProps } from '../types';

export function PhotogrammetryFiguresSection(_props: SectionProps<PhotogrammetryReport>) {
  const assets = useThermalStore((s) => s.assets);
  const { queue, removeFromReport, moveEntry, updateEntry } = usePhotogrammetryStore();

  if (queue.length === 0) {
    return (
      <p className="text-[11px] text-gray-500">
        Select photos/videos in the Photogrammetry tab and add them to the report. They
        export here in the chosen order, each with its annotations and caption.
      </p>
    );
  }

  return (
    <>
      <p className="text-[10px] text-gray-500 mb-2">
        {queue.length} figure{queue.length === 1 ? '' : 's'} · listed order = report order ·
        annotations are drawn into each figure on export
      </p>
      <div className="space-y-1.5">
        {queue.map((entry, i) => {
          const a = assets.find((x) => x.id === entry.assetId);
          const isVideo = a?.assetType === 'video';
          return (
            <div key={entry.id} className="flex items-center gap-2 p-2 rounded-lg bg-gray-800/50 border border-gray-700">
              <span className="w-6 text-center text-[11px] font-mono text-gray-400">{i + 1}</span>
              <span className="text-xs">{a ? (isVideo ? '🎬' : '📷') : '⚠️'}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-gray-300 truncate">
                  {a?.fileName ?? 'Asset no longer in the library'}
                  {isVideo ? ` · frame ${fmtFrameTime(entry.frameTimeS)}` : ''}
                </div>
                <input
                  className={`${inputCls} mt-1`}
                  value={entry.caption}
                  onChange={(e) => updateEntry(entry.id, { caption: e.target.value })}
                  placeholder={`Figure ${i + 1} caption`}
                />
              </div>
              <div className="flex flex-col items-center text-xs">
                <button
                  onClick={() => moveEntry(entry.id, i - 1)}
                  disabled={i === 0}
                  className="text-gray-500 hover:text-white disabled:opacity-20 leading-none"
                  title="Move up"
                >
                  ▲
                </button>
                <button
                  onClick={() => moveEntry(entry.id, i + 1)}
                  disabled={i === queue.length - 1}
                  className="text-gray-500 hover:text-white disabled:opacity-20 leading-none"
                  title="Move down"
                >
                  ▼
                </button>
              </div>
              <button
                onClick={() => removeFromReport(entry.id)}
                className="text-gray-500 hover:text-red-400 text-xs"
                title="Remove from report"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
