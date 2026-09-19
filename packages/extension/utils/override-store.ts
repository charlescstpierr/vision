import type { Override } from '@vizion/shared';
import { OVERRIDES_STORAGE_PREFIX, overrideKey } from '@vizion/shared';
import { createHistory, push as pushHistory, redo as redoHistory, undo as undoHistory, type HistoryState } from './edit-history.js';

/** Prefix for the `chrome.storage.local` key holding a page's undo/redo history. */
export const HISTORY_STORAGE_PREFIX = 'vizion:history:';

function storageKeyFor(url: string): string {
  return OVERRIDES_STORAGE_PREFIX + overrideKey(url);
}

/** Storage key for a page's undo/redo history, exposed for UI code that listens for changes. */
export function historyStorageKey(url: string): string {
  return HISTORY_STORAGE_PREFIX + overrideKey(url);
}

/** Tail of the write chain for each page, so operations queue up. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `task` after every previously enqueued task for `pageKey` has
 * settled, and returns its result. This serializes the read-modify-write
 * operations below per page: without it, two calls fired without awaiting
 * between them would both read the same array and the second write would
 * silently drop the first override (or, for undo/redo, could disagree with
 * an in-flight history update).
 */
function enqueue<T>(pageKey: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(pageKey) ?? Promise.resolve();
  const result = previous.then(task, task);
  // Keep the queue moving even if a task throws; the rejection itself still
  // propagates to whoever is awaiting `result`.
  queues.set(
    pageKey,
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

export async function loadHistory(url: string): Promise<HistoryState> {
  const key = historyStorageKey(url);
  const result = await chrome.storage.local.get(key);
  const stored = result[key] as HistoryState | undefined;
  if (stored) return stored;
  return createHistory(await loadOverrides(url));
}

/**
 * Writes the overrides list and its history together in a single
 * `chrome.storage.local.set` call, so a failure partway through can never
 * leave one persisted without the other.
 */
async function persist(url: string, overrides: Override[], history: HistoryState): Promise<void> {
  await chrome.storage.local.set({
    [storageKeyFor(url)]: overrides,
    [historyStorageKey(url)]: history,
  });
}

/** Writes `next` as the page's overrides and records the prior list as an undo step. */
async function commit(url: string, next: Override[]): Promise<Override[]> {
  const history = await loadHistory(url);
  await persist(url, next, pushHistory(history, next));
  return next;
}

export async function addOverride(url: string, override: Override): Promise<Override[]> {
  return enqueue(overrideKey(url), async () => commit(url, [...(await loadOverrides(url)), override]));
}

/**
 * Appends several overrides at once as a single undo step: one history push
 * and one storage write, so e.g. applying a quick-style change to multiple
 * selected elements undoes in one action instead of one per element.
 */
export async function addOverrides(url: string, overrides: Override[]): Promise<Override[]> {
  if (overrides.length === 0) return loadOverrides(url);
  return enqueue(overrideKey(url), async () => commit(url, [...(await loadOverrides(url)), ...overrides]));
}

export async function removeOverride(url: string, id: string): Promise<Override[]> {
  return enqueue(overrideKey(url), async () =>
    commit(
      url,
      (await loadOverrides(url)).filter((override) => override.id !== id),
    ),
  );
}

export async function clearOverrides(url: string): Promise<void> {
  await enqueue(overrideKey(url), () => commit(url, []));
}

/** Steps the page's overrides back to the previous list, persisting both the list and the history. */
export async function undoOverrides(url: string): Promise<Override[]> {
  return enqueue(overrideKey(url), async () => {
    const updated = undoHistory(await loadHistory(url));
    await persist(url, updated.present, updated);
    return updated.present;
  });
}

/** Steps the page's overrides forward to a previously undone list. */
export async function redoOverrides(url: string): Promise<Override[]> {
  return enqueue(overrideKey(url), async () => {
    const updated = redoHistory(await loadHistory(url));
    await persist(url, updated.present, updated);
    return updated.present;
  });
}
