import { describe, expect, it } from 'vitest';
import type { ElementContext } from '@vizion/shared';
import { describeChanges, describeChangesForElements, describeTextChange } from './change-to-prompt.js';

function makeElement(overrides: Partial<ElementContext> = {}): ElementContext {
  return {
    selector: '#hero',
    tagName: 'button',
    id: undefined,
    classes: [],
    textContent: '',
    outerHtml: '',
    domPath: [],
    rect: { x: 0, y: 0, width: 0, height: 0 },
    computedStyles: {},
    pageUrl: 'https://example.com/',
    ...overrides,
  };
}

describe('describeChanges', () => {
  it('lists each property -> value change', () => {
    const description = describeChanges(makeElement({ id: 'hero' }), [
      { property: 'color', value: '#ff0000' },
      { property: 'font-size', value: '18px' },
    ]);
    expect(description).toBe('Change the styles of this element (button#hero): color → #ff0000, font-size → 18px.');
  });

  it('omits the id fragment when the element has none', () => {
    const description = describeChanges(makeElement(), [{ property: 'color', value: 'red' }]);
    expect(description).toBe('Change the styles of this element (button): color → red.');
  });
});

describe('describeChangesForElements', () => {
  it('delegates to describeChanges for a single element', () => {
    const elements = [makeElement({ id: 'hero' })];
    expect(describeChangesForElements(elements, [{ property: 'color', value: 'red' }])).toBe(
      describeChanges(elements[0]!, [{ property: 'color', value: 'red' }]),
    );
  });

  it('lists every selector for several elements', () => {
    const elements = [makeElement({ selector: '#a' }), makeElement({ selector: '.b' })];
    const description = describeChangesForElements(elements, [{ property: 'color', value: 'red' }]);
    expect(description).toBe('Change the styles of these elements (#a, .b): color → red.');
  });
});

describe('describeTextChange', () => {
  it('describes a simple before/after change', () => {
    expect(describeTextChange('Old', 'New')).toBe(
      'Change the text of this element from "Old" to "New".',
    );
  });

  it('truncates each side to 120 characters', () => {
    const before = 'a'.repeat(150);
    const after = 'b'.repeat(150);
    const result = describeTextChange(before, after);
    expect(result).toBe(
      `Change the text of this element from "${'a'.repeat(120)}…" to "${'b'.repeat(120)}…".`,
    );
  });
});
