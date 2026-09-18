import type { RunRequest } from '@vizion/shared';

const MAX_OUTER_HTML_LENGTH = 2000;

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}… (truncated)`;
}

/**
 * Builds the prompt sent to an agent CLI from the selected element context
 * and the user's task, per docs/PLAN.md 3.3.
 */
export function buildPrompt(req: RunRequest, cwd: string): string {
  const { element, pageUrl, prompt } = req;
  const classes = element.classes.length > 0 ? element.classes.join(' ') : '(none)';
  const domPath = element.domPath.join(' > ');
  const outerHtml = truncate(element.outerHtml, MAX_OUTER_HTML_LENGTH);

  return [
    `Project: ${cwd}.`,
    `Page: ${pageUrl}.`,
    `Selected element: ${element.selector}.`,
    `DOM path: ${domPath}.`,
    `Classes: ${classes}.`,
    `Text: "${element.textContent}".`,
    `HTML: ${outerHtml}`,
    '',
    `Task: ${prompt}`,
    '',
    'Find the source file that renders this element, apply the requested change, and touch nothing else.',
  ].join('\n');
}
