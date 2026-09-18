import type { Override } from '@vizion/shared';
import { OVERRIDES_STORAGE_PREFIX, overrideKey } from '@vizion/shared';
import { applyOverrides } from './overrides.js';
import { loadOverrides } from './override-store.js';

const MUTATION_DEBOUNCE_MS = 100;

/**
 * Keeps overlay-mode overrides applied to a live page: loads them once on
 * start, then re-applies whenever they might have been lost or changed:
 *
 * - `chrome.storage.onChanged` for this page's key (edited from the side panel)
 * - a debounced `MutationObserver` on <html> (childList + subtree), which
 *   catches SPA re-renders that strip our <style> tag or overwrite text
 * - `popstate`, for client-side navigations to a different page (different
 *   origin+pathname => different override set). `pushState`/`replaceState`
 *   are NOT patched for this MVP (per docs/PLAN.md 5): a SPA route change
 *   that never fires `popstate` (e.g. a plain `history.pushState` link)
 *   won't pick up that new page's overrides until a `popstate` or reload.
 */
export class OverrideApplier {
  private overrides: Override[] = [];
  private storageKey: string;
  private observer: MutationObserver | undefined;
  private mutationTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly doc: Document = document) {
    this.storageKey = OVERRIDES_STORAGE_PREFIX + overrideKey(this.doc.location.href);
  }

  async start(): Promise<void> {
    await this.reloadAndApply();

    chrome.storage.onChanged.addListener(this.handleStorageChanged);

    this.observer = new MutationObserver(this.handleMutation);
    this.observer.observe(this.doc.documentElement, { childList: true, subtree: true });

    window.addEventListener('popstate', this.handleNavigation);
  }

  stop(): void {
    chrome.storage.onChanged.removeListener(this.handleStorageChanged);
    this.observer?.disconnect();
    window.removeEventListener('popstate', this.handleNavigation);
    if (this.mutationTimer) clearTimeout(this.mutationTimer);
  }

  private apply(): void {
    applyOverrides(this.doc, this.overrides);
  }

  private async reloadAndApply(): Promise<void> {
    this.overrides = await loadOverrides(this.doc.location.href);
    this.apply();
  }

  private handleStorageChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local' || !(this.storageKey in changes)) return;
    this.overrides = (changes[this.storageKey]?.newValue as Override[] | undefined) ?? [];
    this.apply();
  };

  private handleMutation = (): void => {
    if (this.mutationTimer) clearTimeout(this.mutationTimer);
    this.mutationTimer = setTimeout(() => this.apply(), MUTATION_DEBOUNCE_MS);
  };

  private handleNavigation = (): void => {
    this.storageKey = OVERRIDES_STORAGE_PREFIX + overrideKey(this.doc.location.href);
    void this.reloadAndApply();
  };
}
