import type { ElementContext } from '@vizion/shared';

const TRUNCATE_LIMIT = 120;

export interface StyleChange {
  property: string;
  value: string;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Describes a batch of quick-style changes for the current element as a
 * single sentence suitable for the agent prompt, e.g.:
 * "Change the styles of this element: color → #ff0000, font-size → 18px."
 */
export function describeChanges(element: ElementContext, changes: StyleChange[]): string {
  const list = changes.map((c) => `${c.property} → ${c.value}`).join(', ');
  return `Change the styles of this element (${element.tagName}${element.id ? `#${element.id}` : ''}): ${list}.`;
}

/**
 * Describes a batch of quick-style changes across one or more selected
 * elements. With a single element it matches `describeChanges` exactly
 * (kept separate so `describeChanges`'s own tests are unaffected); with
 * several, it lists every selector in one sentence instead.
 */
export function describeChangesForElements(elements: ElementContext[], changes: StyleChange[]): string {
  if (elements.length <= 1) {
    return describeChanges(elements[0]!, changes);
  }
  const list = changes.map((c) => `${c.property} → ${c.value}`).join(', ');
  const selectors = elements.map((e) => e.selector).join(', ');
  return `Change the styles of these elements (${selectors}): ${list}.`;
}

/**
 * Describes a committed inline text edit as a single sentence suitable for
 * the agent prompt, truncating each side to 120 characters.
 */
export function describeTextChange(before: string, after: string): string {
  return `Change the text of this element from "${truncate(before, TRUNCATE_LIMIT)}" to "${truncate(after, TRUNCATE_LIMIT)}".`;
}
