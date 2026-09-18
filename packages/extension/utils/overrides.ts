import type { Override } from '@vizion/shared';

/** Id of the `<style>` tag Vizion owns for overlay-mode style overrides. */
export const OVERRIDE_STYLE_TAG_ID = 'vizion-overrides';

/** Renders the style overrides as one `!important` CSS rule per override. */
export function buildOverrideCss(overrides: Override[]): string {
  return overrides
    .filter((override): override is Extract<Override, { kind: 'style' }> => override.kind === 'style')
    .map((override) => `${override.selector} { ${override.property}: ${override.value} !important; }`)
    .join('\n');
}

/**
 * Applies `overrides` to `doc`: upserts a single `<style id="vizion-overrides">`
 * tag with the current style CSS, and sets `textContent` on every element
 * matching a text override's selector (skipping elements already at that
 * value, so this is safe to call repeatedly / from a MutationObserver).
 */
export function applyOverrides(doc: Document, overrides: Override[]): void {
  const css = buildOverrideCss(overrides);
  let style = doc.getElementById(OVERRIDE_STYLE_TAG_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement('style');
    style.id = OVERRIDE_STYLE_TAG_ID;
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  if (style.textContent !== css) {
    style.textContent = css;
  }

  for (const override of overrides) {
    if (override.kind !== 'text') continue;
    const elements = doc.querySelectorAll(override.selector);
    for (const el of Array.from(elements)) {
      if (el.textContent !== override.value) {
        el.textContent = override.value;
      }
    }
  }
}
