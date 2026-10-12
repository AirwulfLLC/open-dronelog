/**
 * Add-ons — install, enable and remove the optional feature packs. Each
 * add-on ships as its own installer; once run, it appears here (Refresh) and
 * its tab shows up in the sidebar.
 */

import { useEffect, useState } from 'react';
import { getAddonsDir, isAddonsSupported } from '@/lib/addonsApi';
import { useAddonStore, type AddonFeature } from '@/stores/addonStore';

/** Where the add-on installers are published. */
const DOWNLOADS_URL = 'https://github.com/AirwulfLLC/open-dronelog/releases';

interface CatalogEntry {
  id: string;
  name: string;
  feature: AddonFeature;
  description: string;
  installerName: string;
  note?: string;
}

/** The add-ons this build of the app knows how to host. */
const CATALOG: CatalogEntry[] = [
  {
    id: 'thermal',
    name: 'Thermal Analysis Studio',
    feature: 'thermal',
    description:
      'DJI radiometric image analysis: temperature statistics and isotherms, range isolation, AI variance analysis, heat-flow networks, Metashape orthomosaics and thermal inspection reports.',
    installerName: 'OpenDroneLog-Thermal-Addon_<version>_x64-setup.exe',
    note: 'Includes the DJI Thermal SDK runtime.',
  },
  {
    id: 'photogrammetry',
    name: 'Photogrammetry',
    feature: 'photogrammetry',
    description:
      'Photo and video library with annotations, Metashape deliverables, an ordered figure queue and photogrammetry survey reports.',
    installerName: 'OpenDroneLog-Photogrammetry-Addon_<version>_x64-setup.exe',
  },
];

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function AddonsModal({ isOpen, onClose }: Props) {
  const { addons, loaded, error, load, setEnabled, uninstall, clearError } = useAddonStore();
  const [dir, setDir] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !isAddonsSupported()) return;
    load();
    getAddonsDir().then(setDir).catch(() => setDir(null));
  }, [isOpen, load]);

  if (!isOpen) return null;

  const openUrl = async (url: string) => {
    try {
      const { openUrl: open } = await import('@tauri-apps/plugin-opener');
      await open(url);
    } catch (e) {
      window.alert(`Could not open ${url}: ${e instanceof Error ? e.message : e}`);
    }
  };
  const openDir = async () => {
    if (!dir) return;
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener');
      await openPath(dir);
    } catch (e) {
      window.alert(`Could not open the add-ons folder: ${e instanceof Error ? e.message : e}`);
    }
  };

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    try {
      await fn();
    } finally {
      setBusyId(null);
    }
  };

  const installedById = new Map(addons.map((a) => [a.id, a]));
  // Installed add-ons this build does not know about still deserve a row
  const unknownInstalled = addons.filter((a) => !CATALOG.some((c) => c.id === a.id));

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[90vh] bg-drone-secondary border border-gray-700 rounded-xl flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">🧩 Add-ons</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => load()}
              className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium"
              title="Re-scan the add-ons folder (after running an add-on installer)"
            >
              ↻ Refresh
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-white px-2 py-1">
              ✕
            </button>
          </div>
        </div>

        {!isAddonsSupported() && (
          <div className="px-4 py-3 text-xs text-gray-400">Add-ons are available in the desktop app only.</div>
        )}

        {error && (
          <div className="px-4 py-1.5 bg-red-500/15 border-b border-red-500/40 text-xs text-red-300 flex justify-between">
            {error}
            <button onClick={clearError} className="hover:text-white">✕</button>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          <p className="text-[11px] text-gray-400">
            Add-ons extend the dashboard with their own tab. Each one is delivered as a separate
            installer: download it, run it, then press <b>Refresh</b> — its tab appears in the
            sidebar. Disable an add-on to hide its tab without removing it.
          </p>

          {CATALOG.map((entry) => {
            const installed = installedById.get(entry.id);
            const busy = busyId === entry.id;
            return (
              <div key={entry.id} className="p-3 rounded-lg border border-gray-700 bg-gray-800/40">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{entry.name}</span>
                      {installed ? (
                        <span
                          className={`px-1.5 py-0.5 rounded-full text-[10px] border ${
                            installed.enabled
                              ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/40'
                              : 'bg-gray-500/10 text-gray-300 border-gray-500/40'
                          }`}
                        >
                          {installed.enabled ? 'Enabled' : 'Disabled'}
                          {installed.version ? ` · v${installed.version}` : ''}
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded-full text-[10px] border bg-amber-500/10 text-amber-300 border-amber-500/40">
                          Not installed
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-400 mt-1">{entry.description}</p>
                    {entry.note && <p className="text-[10px] text-gray-500 mt-0.5">{entry.note}</p>}
                  </div>
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    {installed ? (
                      <>
                        <label className="inline-flex items-center gap-1.5 text-[11px] text-gray-300 cursor-pointer">
                          <input
                            type="checkbox"
                            className="accent-emerald-500"
                            checked={installed.enabled}
                            disabled={busy || !loaded}
                            onChange={(e) =>
                              withBusy(entry.id, () => setEnabled(entry.id, e.target.checked))
                            }
                          />
                          Enabled
                        </label>
                        <button
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Remove the ${entry.name} add-on? Its files (${installed.path}) are deleted; your imported data is kept.`,
                              )
                            ) {
                              void withBusy(entry.id, () => uninstall(entry.id));
                            }
                          }}
                          className="text-[11px] text-gray-500 hover:text-red-400 disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => openUrl(DOWNLOADS_URL)}
                        className="px-3 py-1.5 rounded bg-drone-primary hover:bg-drone-primary/80 text-white text-xs font-medium whitespace-nowrap"
                        title={`Download ${entry.installerName} and run it`}
                      >
                        Download installer…
                      </button>
                    )}
                  </div>
                </div>
                {!installed && (
                  <p className="text-[10px] text-gray-500 mt-2">
                    Installer: <code className="text-gray-400">{entry.installerName}</code> — run it,
                    then press Refresh.
                  </p>
                )}
              </div>
            );
          })}

          {unknownInstalled.map((a) => (
            <div key={a.id} className="p-3 rounded-lg border border-gray-700 bg-gray-800/40">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-sm font-semibold text-white">{a.name}</span>
                  <span className="ml-2 text-[10px] text-gray-500">{a.id}{a.version ? ` · v${a.version}` : ''}</span>
                  <p className="text-[11px] text-gray-400 mt-1">
                    {a.description || 'Installed add-on this version of the app does not recognise.'}
                  </p>
                </div>
                <label className="inline-flex items-center gap-1.5 text-[11px] text-gray-300 cursor-pointer flex-shrink-0">
                  <input
                    type="checkbox"
                    className="accent-emerald-500"
                    checked={a.enabled}
                    onChange={(e) => withBusy(a.id, () => setEnabled(a.id, e.target.checked))}
                  />
                  Enabled
                </label>
              </div>
            </div>
          ))}
        </div>

        <div className="px-4 py-2 border-t border-gray-700 flex items-center justify-between gap-3 text-[10px] text-gray-500">
          <span className="truncate" title={dir ?? ''}>
            Add-ons folder: {dir ?? '—'}
          </span>
          <button onClick={openDir} disabled={!dir} className="text-gray-300 hover:text-white disabled:opacity-40 whitespace-nowrap">
            Open folder
          </button>
        </div>
      </div>
    </div>
  );
}
