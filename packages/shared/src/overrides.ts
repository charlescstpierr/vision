/**
 * A single persisted overlay-mode change to a page: either a `!important`
 * inline style rule or a text replacement, scoped to a CSS selector. See
 * docs/PLAN.md 3.1/5 (mode overlay).
 */
export type Override =
  | { id: string; selector: string; kind: 'style'; property: string; value: string; createdAt: number }
  | { id: string; selector: string; kind: 'text'; value: string; createdAt: number };

/** Prefix for the `chrome.storage.local` key holding a page's overrides. */
export const OVERRIDES_STORAGE_PREFIX = 'vizion:overrides:';

/**
 * Storage key for a page's overrides: origin + pathname, dropping query and
 * hash so overrides survive query-string/hash changes on the same page.
 */
export function overrideKey(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}
