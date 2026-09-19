import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_PORT } from '@vizion/shared';

export interface VizionSettings {
  port: number;
  token: string;
}

/** `chrome.storage.local` key for the persisted connection settings. */
export const SETTINGS_STORAGE_KEY = 'vizion:settings';

export const DEFAULT_SETTINGS: VizionSettings = { port: DEFAULT_PORT, token: '' };

function normalize(stored: Partial<VizionSettings> | undefined): VizionSettings {
  return {
    port: typeof stored?.port === 'number' && Number.isFinite(stored.port) ? stored.port : DEFAULT_SETTINGS.port,
    token: typeof stored?.token === 'string' ? stored.token : DEFAULT_SETTINGS.token,
  };
}

/**
 * Loads/persists the port and pairing token the side panel connects to the
 * local Vizion server with, in `chrome.storage.local` under
 * `vizion:settings`. `save` both updates local state and writes through, so
 * `useVizionServer` reconnects as soon as the user hits "Enregistrer".
 */
export function useSettings(): { settings: VizionSettings; save: (next: VizionSettings) => void } {
  const [settings, setSettings] = useState<VizionSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    void chrome.storage.local.get(SETTINGS_STORAGE_KEY).then((result) => {
      if (cancelled) return;
      const stored = result[SETTINGS_STORAGE_KEY] as Partial<VizionSettings> | undefined;
      if (stored) setSettings(normalize(stored));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback((next: VizionSettings) => {
    const normalized = normalize(next);
    setSettings(normalized);
    void chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: normalized });
  }, []);

  return { settings, save };
}
