/**
 * Installed add-ons and the features they switch on. The dashboard shows the
 * Thermal / Photogrammetry tabs only while an enabled add-on provides them.
 */

import { create } from 'zustand';
import * as addonsApi from '@/lib/addonsApi';
import type { AddonInfo } from '@/lib/addonsApi';

export type AddonFeature = 'thermal' | 'photogrammetry';

export function addonProvides(addons: AddonInfo[], feature: AddonFeature): boolean {
  return addons.some((a) => a.enabled && a.provides.includes(feature));
}

interface AddonState {
  addons: AddonInfo[];
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  uninstall: (id: string) => Promise<void>;
  clearError: () => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useAddonStore = create<AddonState>((set, get) => ({
  addons: [],
  loaded: false,
  error: null,

  load: async () => {
    try {
      set({ addons: await addonsApi.listAddons(), loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: message(e) });
    }
  },

  setEnabled: async (id, enabled) => {
    try {
      await addonsApi.setAddonEnabled(id, enabled);
    } catch (e) {
      set({ error: message(e) });
    }
    await get().load();
  },

  uninstall: async (id) => {
    try {
      await addonsApi.uninstallAddon(id);
    } catch (e) {
      set({ error: message(e) });
    }
    await get().load();
  },

  clearError: () => set({ error: null }),
}));
