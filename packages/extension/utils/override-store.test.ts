import { beforeEach, describe, expect, it } from 'vitest';
import type { Override } from '@vizion/shared';
import {
  addOverride,
  addOverrides,
  historyStorageKey,
  loadHistory,
  loadOverrides,
  redoOverrides,
  removeOverride,
  undoOverrides,
  clearOverrides,
} from './override-store.js';

/** Every call made to the fake `chrome.storage.local.set`, keys in call order. */
let setCalls: string[][] = [];

/** Minimal fake of `chrome.storage.local`, with a delay on `get` so
 * concurrent read-modify-write calls actually interleave in tests. Also
 * records every `set` call's keys, so tests can assert a mutation persists
 * the overrides list and its history together in one call. */
function installFakeChromeStorage(): void {
  const store = new Map<string, unknown>();
  setCalls = [];

  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: (key: string) =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ [key]: store.get(key) }), 0);
          }),
        set: (items: Record<string, unknown>) =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              setCalls.push(Object.keys(items));
              for (const [k, v] of Object.entries(items)) store.set(k, v);
              resolve();
            }, 0);
          }),
      },
    },
  };
}

function makeOverride(id: string): Override {
  return { id, selector: '.title', kind: 'text', value: id, createdAt: 0 };
}

beforeEach(() => {
  installFakeChromeStorage();
});

describe('addOverride concurrency', () => {
  it('keeps both overrides when two addOverride calls fire without awaiting between them', async () => {
    const first = addOverride('http://localhost/page', makeOverride('a'));
    const second = addOverride('http://localhost/page', makeOverride('b'));

    await Promise.all([first, second]);

    const stored = await loadOverrides('http://localhost/page');
    expect(stored.map((o) => o.id).sort()).toEqual(['a', 'b']);
  });
});

describe('undo/redo', () => {
  const url = 'http://localhost/undo-page';

  it('undo restores the list from before the last mutation, and redo re-applies it', async () => {
    await addOverride(url, makeOverride('a'));
    await addOverride(url, makeOverride('b'));

    const afterUndo = await undoOverrides(url);
    expect(afterUndo.map((o) => o.id)).toEqual(['a']);
    expect((await loadOverrides(url)).map((o) => o.id)).toEqual(['a']);

    const afterRedo = await redoOverrides(url);
    expect(afterRedo.map((o) => o.id)).toEqual(['a', 'b']);
    expect((await loadOverrides(url)).map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('also records removals and undoes them back to the removed override', async () => {
    const other = url + '-remove';
    await addOverride(other, makeOverride('a'));
    await addOverride(other, makeOverride('b'));
    await removeOverride(other, 'a');
    expect((await loadOverrides(other)).map((o) => o.id)).toEqual(['b']);

    const restored = await undoOverrides(other);
    expect(restored.map((o) => o.id).sort()).toEqual(['a', 'b']);
  });

  it('undo is a no-op with no history yet', async () => {
    const fresh = url + '-fresh';
    const result = await undoOverrides(fresh);
    expect(result).toEqual([]);
  });
});

describe('atomic storage writes', () => {
  const url = 'http://localhost/atomic-page';

  /** Asserts the mutation just run made exactly one `set` call, carrying
   * both the overrides list and the history for `pageUrl`. Assumes
   * `setCalls` was reset right before that mutation ran. */
  function expectAtomicSet(pageUrl: string): void {
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toHaveLength(2);
    expect(setCalls[0]).toContain(historyStorageKey(pageUrl));
  }

  it('addOverride persists overrides and history in a single set call', async () => {
    setCalls = [];
    await addOverride(url, makeOverride('a'));
    expectAtomicSet(url);
  });

  it('removeOverride persists overrides and history in a single set call', async () => {
    const page = url + '-remove';
    await addOverride(page, makeOverride('a'));
    setCalls = [];
    await removeOverride(page, 'a');
    expectAtomicSet(page);
  });

  it('clearOverrides persists overrides and history in a single set call', async () => {
    const page = url + '-clear';
    await addOverride(page, makeOverride('a'));
    setCalls = [];
    await clearOverrides(page);
    expectAtomicSet(page);
  });

  it('undoOverrides persists overrides and history in a single set call', async () => {
    const page = url + '-undo';
    await addOverride(page, makeOverride('a'));
    setCalls = [];
    await undoOverrides(page);
    expectAtomicSet(page);
  });

  it('redoOverrides persists overrides and history in a single set call', async () => {
    const page = url + '-redo';
    await addOverride(page, makeOverride('a'));
    await undoOverrides(page);
    setCalls = [];
    await redoOverrides(page);
    expectAtomicSet(page);
  });
});

describe('addOverrides (batch)', () => {
  const url = 'http://localhost/batch-page';

  it('appends all entries with a single history push and a single storage write', async () => {
    await addOverrides(url, [makeOverride('a'), makeOverride('b'), makeOverride('c')]);

    expect((await loadOverrides(url)).map((o) => o.id)).toEqual(['a', 'b', 'c']);
    expect((await loadHistory(url)).past).toHaveLength(1);
    expect(setCalls.filter((keys) => keys.includes(historyStorageKey(url)))).toHaveLength(1);

    const afterUndo = await undoOverrides(url);
    expect(afterUndo).toEqual([]);
  });
});
