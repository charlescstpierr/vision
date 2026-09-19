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

/**
 * Builds the prompt for an overlay-mode run: same element description as
 * `buildPrompt`, but the agent runs in an empty throwaway directory, cannot
 * touch any files, and must answer with a JSON array of style/text overrides
 * scoped to the selected element(s) instead of editing source.
 */
export function buildOverlayPrompt(
  req: RunRequest & { elements?: ElementContext[] },
  cwd: string,
  options: { allowScreenshotRead?: boolean } = {},
): string {
  const { element, pageUrl, prompt, elements } = req;
  const list = elements && elements.length > 1 ? elements : [element];
  const selectors = list.map((el) => el.selector);
  // JSON.stringify (not manual quoting) so a selector containing backslashes
  // or quotes (e.g. `#\31 23` from CSS.escape) round-trips as a valid JSON
  // string in the prompt the agent is told to copy back verbatim.
  const selectorList = selectors.map((selector) => JSON.stringify(selector)).join(', ');

  const descriptionLines =
    list.length > 1
      ? list.flatMap((el, index) => {
          const lines = describeElementLines(el, MAX_OUTER_HTML_LENGTH_MULTI, 'Selector');
          return [`${index + 1}. ${lines[0]}`, ...lines.slice(1).map((line) => `   ${line}`)];
        })
      : describeElementLines(element, MAX_OUTER_HTML_LENGTH, 'Selected element');

  const header =
    list.length > 1
      ? [`Project: ${cwd}.`, `Page: ${pageUrl}.`, `Selected elements (${list.length}):`, ...descriptionLines]
      : [`Project: ${cwd}.`, `Page: ${pageUrl}.`, ...descriptionLines];

  return [
    ...header,
    '',
    `Task: ${prompt}`,
    '',
    options.allowScreenshotRead
      ? 'You are running in OVERLAY MODE, inside an empty, throwaway sandbox directory: it is not the real project. You cannot edit any files. Do not use any tool except as allowed below — just answer in text.'
      : 'You are running in OVERLAY MODE, inside an empty, throwaway sandbox directory: it is not the real project. You cannot edit any files and must not use any tools (no Bash, Edit, Write, MultiEdit, or similar) — just answer in text.',
    `Reply with ONLY a fenced \`\`\`json code block containing a JSON array of override objects scoped to the selector(s) above (${selectorList}), each one of:`,
    '  { "selector": "<one of the selectors above>", "kind": "style", "property": "<css-property>", "value": "<css-value>" }',
    '  { "selector": "<one of the selectors above>", "kind": "text", "value": "<new text content>" }',
    `"selector" must be exactly one of: ${selectorList}.`,
    'Prefer as few, precise overrides as possible.',
    'You may put one short sentence of context before the code block (an optional note), but the code block itself must contain ONLY the JSON array.',
  ].join('\n');
}

/**
 * Appends a note pointing the agent at the saved screenshot file, used by
 * both `buildPrompt` and `buildOverlayPrompt` outputs when the run carries
 * one. Kept as a separate step (rather than baked into the builders above)
 * so both runners can append it after picking whichever prompt they built.
 *
 * `options.readOnly` (overlay/read-only runs) swaps in a note that
 * explicitly carves out the Read tool from the "no tools" instruction —
 * otherwise that instruction would contradict the need to view the
 * screenshot, since Read is the only way to look at it.
 */
export function appendScreenshotNote(
  prompt: string,
  screenshotPath: string,
  options: { readOnly?: boolean } = {},
): string {
  const note = options.readOnly
    ? `You may use the Read tool ONLY to view the screenshot saved at ${screenshotPath}; use no other tool and edit nothing.`
    : `A screenshot of the selected element is saved at ${screenshotPath}. View it before deciding what to change.`;
  return `${prompt}\n\n${note}`;
}
