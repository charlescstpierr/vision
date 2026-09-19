import { describe, expect, it } from 'vitest';
import { parseOverlayProposal } from './overlay.js';

const SELECTORS = ['#app > button.primary', '.card__title'];

describe('parseOverlayProposal', () => {
  it('parses a bare fenced json block', () => {
    const text = [
      '```json',
      '[{ "selector": "#app > button.primary", "kind": "style", "property": "color", "value": "blue" }]',
      '```',
    ].join('\n');
    const result = parseOverlayProposal(text, SELECTORS);
    expect(result).toEqual({
      overrides: [{ selector: '#app > button.primary', kind: 'style', property: 'color', value: 'blue' }],
    });
  });

  it('captures trailing prose before the block as a note', () => {
    const text = [
      "I'll just tweak the color.",
      '```json',
      '[{ "selector": ".card__title", "kind": "text", "value": "Hello" }]',
      '```',
    ].join('\n');
    const result = parseOverlayProposal(text, SELECTORS);
    expect(result).toEqual({
      overrides: [{ selector: '.card__title', kind: 'text', value: 'Hello' }],
      note: "I'll just tweak the color.",
    });
  });

  it('falls back to the last top-level array when there is no fenced block', () => {
    const text = 'Sure, here you go: [{ "selector": ".card__title", "kind": "text", "value": "Hi" }]';
    const result = parseOverlayProposal(text, SELECTORS);
    expect(result).toEqual({
      overrides: [{ selector: '.card__title', kind: 'text', value: 'Hi' }],
      note: 'Sure, here you go:',
    });
  });

  it('drops invalid items but keeps valid ones', () => {
    const text = [
      '```json',
      JSON.stringify([
        { selector: '.card__title', kind: 'style', property: 'color' }, // missing value
        { selector: '#app > button.primary', kind: 'style', property: 'color', value: 'red' },
      ]),
      '```',
    ].join('\n');
    const result = parseOverlayProposal(text, SELECTORS);
    expect(result).toEqual({
      overrides: [{ selector: '#app > button.primary', kind: 'style', property: 'color', value: 'red' }],
    });
  });

  it('drops items with a selector outside the allowed list and mentions it in note', () => {
    const text = [
      '```json',
      JSON.stringify([
        { selector: '.not-selected', kind: 'text', value: 'nope' },
        { selector: '.card__title', kind: 'text', value: 'Hello' },
      ]),
      '```',
    ].join('\n');
    const result = parseOverlayProposal(text, SELECTORS);
    if ('error' in result) throw new Error('expected a result');
    expect(result.overrides).toEqual([{ selector: '.card__title', kind: 'text', value: 'Hello' }]);
    expect(result.note).toContain('.not-selected');
  });

  it('returns an error when nothing usable is found', () => {
    expect(parseOverlayProposal('just some prose, no json here', SELECTORS)).toEqual({
      error: "L'agent n'a pas renvoyé de proposition exploitable.",
    });
  });

  it('returns an error when the block parses but every item is invalid', () => {
    const text = '```json\n[{ "selector": ".card__title", "kind": "bogus" }]\n```';
    expect(parseOverlayProposal(text, SELECTORS)).toEqual({
      error: "L'agent n'a pas renvoyé de proposition exploitable.",
    });
  });

  it('accepts a text override with an empty value (used to remove text)', () => {
    const text = '```json\n[{ "selector": ".card__title", "kind": "text", "value": "" }]\n```';
    const result = parseOverlayProposal(text, SELECTORS);
    expect(result).toEqual({
      overrides: [{ selector: '.card__title', kind: 'text', value: '' }],
    });
  });

  it('still requires a non-empty property/value for a style override', () => {
    const text = '```json\n[{ "selector": ".card__title", "kind": "style", "property": "", "value": "" }]\n```';
    expect(parseOverlayProposal(text, SELECTORS)).toEqual({
      error: "L'agent n'a pas renvoyé de proposition exploitable.",
    });
  });

  it('drops a style value that tries to inject a new rule via CSS', () => {
    const text = [
      '```json',
      JSON.stringify([
        { selector: '.card__title', kind: 'style', property: 'color', value: 'red; } body { display: none' },
      ]),
      '```',
    ].join('\n');
    const result = parseOverlayProposal(text, SELECTORS);
    expect(result).toEqual({ error: "L'agent n'a pas renvoyé de proposition exploitable." });
  });

  it('strips a trailing !important from a style value (the applier adds its own)', () => {
    const text = [
      '```json',
      JSON.stringify([
        { selector: '.card__title', kind: 'style', property: 'color', value: 'red !important' },
      ]),
      '```',
    ].join('\n');
    const result = parseOverlayProposal(text, SELECTORS);
    expect(result).toEqual({
      overrides: [{ selector: '.card__title', kind: 'style', property: 'color', value: 'red' }],
    });
  });

  it('accepts a custom property as a style declaration', () => {
    const text = [
      '```json',
      JSON.stringify([
        { selector: '.card__title', kind: 'style', property: '--my-color', value: 'blue' },
      ]),
      '```',
    ].join('\n');
    const result = parseOverlayProposal(text, SELECTORS);
    expect(result).toEqual({
      overrides: [{ selector: '.card__title', kind: 'style', property: '--my-color', value: 'blue' }],
    });
  });

  it('does not let a bracket inside a quoted value truncate the bare-array fallback', () => {
    // The `[` inside the "[done]" string value must not be treated as the
    // start of its own (incomplete) candidate array.
    const text = 'Sure: [{ "selector": ".card__title", "kind": "text", "value": "[done]" }]';
    const result = parseOverlayProposal(text, SELECTORS);
    if ('error' in result) throw new Error('expected a result');
    expect(result.overrides).toEqual([{ selector: '.card__title', kind: 'text', value: '[done]' }]);
  });
});
