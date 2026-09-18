import type { Override } from '@vizion/shared';
import { OVERRIDES_STORAGE_PREFIX, overrideKey } from '@vizion/shared';

function storageKeyFor(url: string): string {
  return OVERRIDES_STORAGE_PREFIX + overrideKey(url);
}

export async function loadOverrides(url: string): Promise<Override[]> {
  const key = storageKeyFor(url);
  const result = await chrome.storage.local.get(key);
  return (result[key] as Override[] | undefined) ?? [];
}

export async function saveOverrides(url: string, overrides: Override[]): Promise<void> {
  await chrome.storage.local.set({ [storageKeyFor(url)]: overrides });
}

export async function addOverride(url: string, override: Override): Promise<Override[]> {
  const next = [...(await loadOverrides(url)), override];
  await saveOverrides(url, next);
  return next;
}

export async function removeOverride(url: string, id: string): Promise<Override[]> {
  const next = (await loadOverrides(url)).filter((override) => override.id !== id);
  await saveOverrides(url, next);
  return next;
}

export async function clearOverrides(url: string): Promise<void> {
  await saveOverrides(url, []);
}
