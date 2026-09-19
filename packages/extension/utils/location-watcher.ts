/**
 * Polls `getKey()` on an interval and calls `onChange` whenever the value it
 * returns changes. Used to detect SPA navigations (e.g. `history.pushState`)
 * from the content script's isolated world, where patching `history` would
 * not see the page's own calls: `popstate` alone misses `pushState`/
 * `replaceState` navigations that never fire it.
 *
 * `getKey` should return whatever identifies "a different page" to the
 * caller (e.g. `overrideKey(location.href)`, origin + pathname) so that
 * query-string/hash-only changes don't spuriously trigger `onChange`.
 *
 * Pure/testable: takes plain functions, so it can be driven by fake timers
 * and a mutable fake href in tests, with no DOM/`chrome.*` dependency.
 */
export interface LocationWatcher {
  start(): void;
  stop(): void;
}

export function createLocationWatcher(
  getKey: () => string,
  onChange: (key: string) => void,
  intervalMs: number,
): LocationWatcher {
  let lastKey = getKey();
  let timer: ReturnType<typeof setInterval> | undefined;

  function tick(): void {
    const key = getKey();
    if (key !== lastKey) {
      lastKey = key;
      onChange(key);
    }
  }

  return {
    start(): void {
      lastKey = getKey();
      if (timer !== undefined) return;
      timer = setInterval(tick, intervalMs);
    },
    stop(): void {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
