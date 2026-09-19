import type { Override } from '@vizion/shared';
import { OVERRIDES_STORAGE_PREFIX, overrideKey } from '@vizion/shared';

function storageKeyFor(url: string): string {
  return OVERRIDES_STORAGE_PREFIX + overrideKey(url);
}

/** Tail of the write chain for each storage key, so operations queue up. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `task` after every previously enqueued task for `key` has settled,
 * and returns its result. This serializes the read-modify-write operations
 * below per storage key: without it, two `addOverride` calls fired without
 * awaiting between them would both read the same array and the second
 * write would silently drop the first override.
 */
function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.then(task, task);
  // Keep the queue moving even if a task throws; the rejection itself still
  // propagates to whoever is awaiting `result`.
  queues.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
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
  return enqueue(storageKeyFor(url), async () => {
    const next = [...(await loadOverrides(url)), override];
    await saveOverrides(url, next);
    return next;
  });
}

export async function removeOverride(url: string, id: string): Promise<Override[]> {
  return enqueue(storageKeyFor(url), async () => {
    const next = (await loadOverrides(url)).filter((override) => override.id !== id);
    await saveOverrides(url, next);
    return next;
  });
}

export async function clearOverrides(url: string): Promise<void> {
  await enqueue(storageKeyFor(url), () => saveOverrides(url, []));
}
