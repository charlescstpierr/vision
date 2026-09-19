import { beforeEach, describe, expect, it } from 'vitest';
import type { Override } from '@vizion/shared';
import { addOverride, loadOverrides } from './override-store.js';

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
