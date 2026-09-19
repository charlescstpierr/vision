import type { ElementContext } from '@vizion/shared';

const COMPUTED_STYLE_KEYS = [
  'color',
  'background-color',
  'font-size',
  'font-family',
  'font-weight',
  'line-height',
  'padding',
  'margin',
  'display',
  'width',
  'height',
  'border',
  'border-radius',
  'text-align',
];

const OUTER_HTML_LIMIT = 2000;
const TEXT_CONTENT_LIMIT = 300;
const SOURCE_ATTRIBUTE = 'data-vizion-source';

function isUniqueId(doc: Document, id: string): boolean {
  return doc.querySelectorAll(`#${CSS.escape(id)}`).length === 1;
}

function nthOfTypeIndex(el: Element): number {
  let index = 1;
  let sibling = el.previousElementSibling;
  while (sibling) {
    if (sibling.tagName === el.tagName) index += 1;
    sibling = sibling.previousElementSibling;
  }
  return index;
}

function segmentFor(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;
  const sameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  if (sameTagSiblings.length <= 1) return tag;
  return `${tag}:nth-of-type(${nthOfTypeIndex(el)})`;
}

/**
 * Builds a CSS selector that uniquely identifies `el` in its document.
 * Prefers `#id` when the id is unique, otherwise walks up to the nearest
 * ancestor with a unique id (or `body`) and builds a nth-of-type path down.
 */
export function buildUniqueSelector(el: Element): string {
  const doc = el.ownerDocument;

  if (el.id && isUniqueId(doc, el.id)) {
    return `#${CSS.escape(el.id)}`;
  }

  const segments: string[] = [];
  let current: Element | null = el;
  let root: Element = doc.body;

  while (current) {
    if (current.id && isUniqueId(doc, current.id)) {
      root = current;
      break;
    }
    if (current === doc.body) {
      root = current;
      break;
    }
    segments.unshift(segmentFor(current));
    current = current.parentElement;
  }

  const rootSelector = root.id && isUniqueId(doc, root.id) ? `#${CSS.escape(root.id)}` : 'body';
  let selector = segments.length > 0 ? `${rootSelector} > ${segments.join(' > ')}` : rootSelector;

  if (doc.querySelectorAll(selector).length === 1) {
    return selector;
  }

  // Fallback: full nth-of-type path from body, guaranteed unique.
  const fullSegments: string[] = [];
  let node: Element | null = el;
  while (node && node !== doc.body) {
    fullSegments.unshift(segmentFor(node));
    node = node.parentElement;
  }
  selector = `body > ${fullSegments.join(' > ')}`;
  return selector;
}

/**
 * Builds a DOM path from `<body>` down to `el`, one entry per ancestor,
 * each formatted as `tag#id.class1.class2.class3` (classes capped at 3).
 */
export function buildDomPath(el: Element): string[] {
  const doc = el.ownerDocument;
  const chain: Element[] = [];
  let current: Element | null = el;
  while (current) {
    chain.unshift(current);
    if (current === doc.body) break;
    current = current.parentElement;
  }

  return chain.map((node) => {
    const tag = node.tagName.toLowerCase();
    const id = node.id ? `#${node.id}` : '';
    const classes = Array.from(node.classList).slice(0, 3);
    const classPart = classes.length > 0 ? `.${classes.join('.')}` : '';
    return `${tag}${id}${classPart}`;
  });
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

/**
 * Reads the `data-vizion-source` build annotation from `el`, or from the
 * closest ancestor that carries one, when `el` itself does not (e.g. a
 * click landed on a plain-text node's parent that a component wraps).
 */
function findSourceLocation(el: Element): string | undefined {
  const annotated = el.closest(`[${SOURCE_ATTRIBUTE}]`);
  return annotated?.getAttribute(SOURCE_ATTRIBUTE) ?? undefined;
}

/**
 * Extracts a full ElementContext snapshot for `el`.
 */
export function extractElementContext(el: Element, pageUrl: string): ElementContext {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const computed = view ? view.getComputedStyle(el) : undefined;

  const computedStyles: Record<string, string> = {};
  for (const key of COMPUTED_STYLE_KEYS) {
    computedStyles[key] = computed ? computed.getPropertyValue(key) : '';
  }

  const rawText = el.textContent ?? '';
  const collapsedText = rawText.trim().replace(/\s+/g, ' ');

  const rect = el.getBoundingClientRect();
  const sourceLocation = findSourceLocation(el);

  return {
    selector: buildUniqueSelector(el),
    tagName: el.tagName.toLowerCase(),
    id: el.id || undefined,
    classes: Array.from(el.classList),
    textContent: truncate(collapsedText, TEXT_CONTENT_LIMIT),
    outerHtml: truncate(el.outerHTML, OUTER_HTML_LIMIT),
    domPath: buildDomPath(el),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    computedStyles,
    pageUrl,
    ...(sourceLocation ? { sourceLocation } : {}),
  };
}
