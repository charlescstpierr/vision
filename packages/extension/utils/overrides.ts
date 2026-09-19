import type { Override } from '@vizion/shared';

/** Id of the `<style>` tag Vizion owns for overlay-mode style overrides. */
export const OVERRIDE_STYLE_TAG_ID = 'vizion-overrides';

/**
 * The `<style>` element Vizion created for overlay-mode overrides, tracked
 * by reference rather than looked up by id. Looking it up by id would risk
 * adopting an unrelated page element that happens to share the id (and
 * writing our CSS into it), so we only ever write into a node we created
 * ourselves, and re-create it if it gets removed from the document (e.g. by
 * a page's own re-render).
 */
let ownedStyleElement: HTMLStyleElement | null = null;

function getOwnedStyleElement(doc: Document): HTMLStyleElement {
  if (ownedStyleElement && ownedStyleElement.isConnected && ownedStyleElement.ownerDocument === doc) {
    return ownedStyleElement;
  }
  const style = doc.createElement('style');
  style.id = OVERRIDE_STYLE_TAG_ID;
  style.setAttribute('data-vizion', 'overrides');
  (doc.head ?? doc.documentElement).appendChild(style);
  ownedStyleElement = style;
  return style;
}

type TextOverrideRecord = { el: WeakRef<Element>; original: string };

/**
 * Per-selector record of the text a text override replaced, so it can be
 * restored if that override is later removed (e.g. the user retracts it in
 * the side panel) without a page reload. Keyed by selector rather than by
 * element, matching how overrides themselves are addressed.
 */
const appliedTextOverrides = new Map<string, TextOverrideRecord>();

/** Renders the style overrides as one `!important` CSS rule per override. */
export function buildOverrideCss(overrides: Override[]): string {
  return overrides
    .filter((override): override is Extract<Override, { kind: 'style' }> => override.kind === 'style')
    .map((override) => `${override.selector} { ${override.property}: ${override.value} !important; }`)
    .join('\n');
}

/**
 * Applies `overrides` to `doc`: upserts Vizion's own `<style>` tag with the
 * current style CSS, sets `textContent` on every element matching a text
 * override's selector (skipping elements already at that value, so this is
 * safe to call repeatedly / from a MutationObserver), and restores the
 * original text of any selector whose text override has been removed since
 * the last call.
 */
export function applyOverrides(doc: Document, overrides: Override[]): void {
  const css = buildOverrideCss(overrides);
  const style = getOwnedStyleElement(doc);
  if (style.textContent !== css) {
    style.textContent = css;
  }

  const textOverridesBySelector = new Map<string, Extract<Override, { kind: 'text' }>>();
  for (const override of overrides) {
    if (override.kind === 'text') textOverridesBySelector.set(override.selector, override);
  }

  for (const [selector, record] of appliedTextOverrides) {
    if (textOverridesBySelector.has(selector)) continue;
    const el = record.el.deref();
    if (el && el.textContent !== record.original) {
      el.textContent = record.original;
    }
    appliedTextOverrides.delete(selector);
  }

  for (const [selector, override] of textOverridesBySelector) {
    const elements = Array.from(doc.querySelectorAll(selector));
    if (!appliedTextOverrides.has(selector) && elements[0]) {
      appliedTextOverrides.set(selector, { el: new WeakRef(elements[0]), original: elements[0].textContent ?? '' });
    }
    for (const el of elements) {
      if (el.textContent !== override.value) {
        el.textContent = override.value;
      }
    }
  }
}
