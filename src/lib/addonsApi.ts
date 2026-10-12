/**
 * Add-ons API: optional feature packs (Thermal Analysis Studio,
 * Photogrammetry) installed by their own installers into the app data
 * folder. Desktop only — the web build has no add-ons.
 */

const isWeb = import.meta.env.VITE_BACKEND === 'web';

export interface AddonInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Features the add-on switches on ("thermal", "photogrammetry"). */
  provides: string[];
  enabled: boolean;
  /** Folder the add-on is installed in. */
  path: string;
}

type InvokeFn = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let _invoke: InvokeFn | null = null;

async function inv<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isWeb) throw new Error('Add-ons are available in the desktop app only.');
  if (!_invoke) {
    const { invoke } = await import('@tauri-apps/api/core');
    _invoke = invoke as InvokeFn;
  }
  return _invoke<T>(cmd, args);
}

export function isAddonsSupported(): boolean {
  return !isWeb;
}

export async function listAddons(): Promise<AddonInfo[]> {
  if (isWeb) return [];
  return inv<AddonInfo[]>('addons_list');
}

export async function setAddonEnabled(id: string, enabled: boolean): Promise<void> {
  await inv('addons_set_enabled', { id, enabled });
}

/** The add-ons folder (created on demand). */
export async function getAddonsDir(): Promise<string> {
  return inv<string>('addons_dir_path');
}

export async function uninstallAddon(id: string): Promise<void> {
  await inv('addons_uninstall', { id });
}
