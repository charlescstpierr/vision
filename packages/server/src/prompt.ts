import type { ElementContext, RunRequest } from '@vizion/shared';

const MAX_OUTER_HTML_LENGTH = 2000;
const MAX_OUTER_HTML_LENGTH_MULTI = 800;

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}… (truncated)`;
}

/** The selector/DOM-path/classes/text/(source)/HTML lines describing one element. */
function describeElementLines(element: ElementContext, maxHtmlLength: number, selectorLabel: string): string[] {
  const classes = element.classes.length > 0 ? element.classes.join(' ') : '(none)';
  const domPath = element.domPath.join(' > ');
  const outerHtml = truncate(element.outerHtml, maxHtmlLength);
  return [
    `${selectorLabel}: ${element.selector}.`,
    ...(element.sourceLocation
      ? [`Source location (from build annotation): ${element.sourceLocation}. Start there.`]
      : []),
    `DOM path: ${domPath}.`,
    `Classes: ${classes}.`,
    `Text: "${element.textContent}".`,
    `HTML: ${outerHtml}`,
  ];
}

/**
 * Builds the prompt sent to an agent CLI from the selected element context(s)
 * and the user's task, per docs/PLAN.md 3.3. When more than one element was
 * selected (`req.elements` has more than one entry), each is described in a
 * numbered list and the task is phrased as applying to all of them; a single
 * element keeps the original flat format.
 */
export function buildPrompt(req: RunRequest & { elements?: ElementContext[] }, cwd: string): string {
  const { element, pageUrl, prompt, elements } = req;

  if (elements && elements.length > 1) {
    const items = elements.flatMap((el, index) => {
      const lines = describeElementLines(el, MAX_OUTER_HTML_LENGTH_MULTI, 'Selector');
      return [`${index + 1}. ${lines[0]}`, ...lines.slice(1).map((line) => `   ${line}`)];
    });
    return [
      `Project: ${cwd}.`,
      `Page: ${pageUrl}.`,
      `Selected elements (${elements.length}):`,
      ...items,
      '',
      `Task: ${prompt}`,
      '',
      'Apply the requested change to all of the elements listed above. Find the source file(s) that render each one and touch nothing else.',
    ].join('\n');
  }

  const lines = describeElementLines(element, MAX_OUTER_HTML_LENGTH, 'Selected element');
  return [
    `Project: ${cwd}.`,
    `Page: ${pageUrl}.`,
    ...lines,
    '',
    `Task: ${prompt}`,
    '',
    'Find the source file that renders this element, apply the requested change, and touch nothing else.',
  ].join('\n');
}
