import { beforeEach, describe, expect, it } from 'vitest';
import type { Override } from '@vizion/shared';
import { applyOverrides, buildOverrideCss, OVERRIDE_STYLE_TAG_ID } from './overrides.js';

function style(selector: string, property: string, value: string): Override {
  return { id: `${selector}-${property}`, selector, kind: 'style', property, value, createdAt: 0 };
}

function text(selector: string, value: string): Override {
  return { id: `${selector}-text`, selector, kind: 'text', value, createdAt: 0 };
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('buildOverrideCss', () => {
  it('renders one !important rule per style override', () => {
    const css = buildOverrideCss([style('.btn', 'color', 'red'), style('#hero', 'font-size', '20px')]);
    expect(css).toBe('.btn { color: red !important; }\n#hero { font-size: 20px !important; }');
  });

  it('ignores text overrides', () => {
    expect(buildOverrideCss([text('.title', 'Hello')])).toBe('');
  });

  it('returns an empty string for no overrides', () => {
    expect(buildOverrideCss([])).toBe('');
  });
});

describe('applyOverrides', () => {
  it('inserts a single style tag in <head> with the built CSS', () => {
    applyOverrides(document, [style('.btn', 'color', 'red')]);
    const tags = document.head.querySelectorAll(`#${OVERRIDE_STYLE_TAG_ID}`);
    expect(tags).toHaveLength(1);
    expect(tags[0]!.textContent).toBe('.btn { color: red !important; }');
  });

  it('calling twice leaves exactly one style tag and updates its content', () => {
    applyOverrides(document, [style('.btn', 'color', 'red')]);
    applyOverrides(document, [style('.btn', 'color', 'blue')]);
    const tags = document.head.querySelectorAll(`#${OVERRIDE_STYLE_TAG_ID}`);
    expect(tags).toHaveLength(1);
    expect(tags[0]!.textContent).toBe('.btn { color: blue !important; }');
  });

  it('re-inserts the style tag if it was removed from the document', () => {
    applyOverrides(document, [style('.btn', 'color', 'red')]);
    document.getElementById(OVERRIDE_STYLE_TAG_ID)?.remove();
    applyOverrides(document, [style('.btn', 'color', 'red')]);
    expect(document.head.querySelectorAll(`#${OVERRIDE_STYLE_TAG_ID}`)).toHaveLength(1);
  });

  it('marks the style tag it owns with data-vizion="overrides"', () => {
    applyOverrides(document, [style('.btn', 'color', 'red')]);
    const tag = document.getElementById(OVERRIDE_STYLE_TAG_ID);
    expect(tag?.getAttribute('data-vizion')).toBe('overrides');
  });

  it('never adopts an unrelated page element with the same id', () => {
    const impostor = document.createElement('div');
    impostor.id = OVERRIDE_STYLE_TAG_ID;
    document.body.appendChild(impostor);
    applyOverrides(document, [style('.btn', 'color', 'red')]);
    expect(impostor.textContent).toBe('');
    const styleTags = document.head.querySelectorAll(`style#${OVERRIDE_STYLE_TAG_ID}`);
    expect(styleTags).toHaveLength(1);
    expect(styleTags[0]!.textContent).toBe('.btn { color: red !important; }');
  });

  it('sets textContent on every element matching a text override selector', () => {
    document.body.innerHTML = '<h1 class="title">old</h1>';
    applyOverrides(document, [text('.title', 'new')]);
    expect(document.querySelector('.title')!.textContent).toBe('new');
  });

  it('skips elements whose textContent already matches (no-op re-apply)', () => {
    document.body.innerHTML = '<h1 class="title">new</h1>';
    const el = document.querySelector('.title')!;
    let mutated = false;
    const original = el.textContent;
    Object.defineProperty(el, 'textContent', {
      get() {
        return original;
      },
      set() {
        mutated = true;
      },
    });
    applyOverrides(document, [text('.title', 'new')]);
    expect(mutated).toBe(false);
  });

  it('restores the original text once a text override is no longer present', () => {
    document.body.innerHTML = '<p class="desc">before</p>';
    applyOverrides(document, [text('.desc', 'after')]);
    expect(document.querySelector('.desc')!.textContent).toBe('after');

    applyOverrides(document, []);
    expect(document.querySelector('.desc')!.textContent).toBe('before');
  });

  it('does not restore text for a selector whose override is still present', () => {
    document.body.innerHTML = '<p class="tagline">before</p>';
    applyOverrides(document, [text('.tagline', 'after')]);
    applyOverrides(document, [text('.tagline', 'after')]);
    expect(document.querySelector('.tagline')!.textContent).toBe('after');
  });
});
