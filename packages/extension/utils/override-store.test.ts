import { beforeEach, describe, expect, it } from 'vitest';
import type { Override } from '@vizion/shared';
import { addOverride, loadOverrides, redoOverrides, removeOverride, undoOverrides } from './override-store.js';

/** Minimal fake of `chrome.storage.local`, with a delay on `get` so
 * concurrent read-modify-write calls actually interleave in tests. */
function installFakeChromeStorage(): void {
  const store = new Map<string, unknown>();

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
