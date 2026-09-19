import type { OverrideProposal } from '@vizion/shared';

const NOTHING_USABLE = "L'agent n'a pas renvoyé de proposition exploitable.";
const MAX_NOTE_LENGTH = 300;

export type OverlayParseResult = { overrides: OverrideProposal[]; note?: string } | { error: string };

/** Finds the matching `]` for the `[` at `start`, respecting quoted strings; -1 if unbalanced. */
function findArrayEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** The last top-level `[...]` array literal found anywhere in `text`, or null. */
function findLastTopLevelArray(text: string): { start: number; end: number } | null {
  let result: { start: number; end: number } | null = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '[') continue;
    const end = findArrayEnd(text, i);
    if (end !== -1) result = { start: i, end };
  }
  return result;
}

/** The LAST ```json fenced block, or (fallback) the last top-level `[...]` array. */
function findJsonBlock(text: string): { json: string; before: string } | null {
  const fenceRe = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = fenceRe.exec(text)) !== null) {
    last = match;
  }
  if (last) {
    return { json: (last[1] ?? '').trim(), before: text.slice(0, last.index) };
  }

  const arr = findLastTopLevelArray(text);
  if (!arr) return null;
  return { json: text.slice(arr.start, arr.end), before: text.slice(0, arr.start) };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Parses an agent's overlay-mode reply into `OverrideProposal`s. Looks for
 * the last ```json fenced block in `text` (falling back to the last
 * top-level `[...]` array), validates each item, and drops anything whose
 * selector isn't in `allowedSelectors` (mentioning it in `note`). Returns
 * `{ error }` when nothing usable was found.
 */
export function parseOverlayProposal(text: string, allowedSelectors: string[]): OverlayParseResult {
  const found = findJsonBlock(text);
  if (!found) return { error: NOTHING_USABLE };

  let parsed: unknown;
  try {
    parsed = JSON.parse(found.json);
  } catch {
    return { error: NOTHING_USABLE };
  }
  if (!Array.isArray(parsed)) return { error: NOTHING_USABLE };

  const overrides: OverrideProposal[] = [];
  const droppedSelectors = new Set<string>();

  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const selector = obj.selector;
    if (!isNonEmptyString(selector)) continue;
    if (!allowedSelectors.includes(selector)) {
      droppedSelectors.add(selector);
      continue;
    }

    if (obj.kind === 'style' && isNonEmptyString(obj.property) && isNonEmptyString(obj.value)) {
      overrides.push({ selector, kind: 'style', property: obj.property, value: obj.value });
    } else if (obj.kind === 'text' && isNonEmptyString(obj.value)) {
      overrides.push({ selector, kind: 'text', value: obj.value });
    }
  }

  const noteParts: string[] = [];
  const beforeTrimmed = found.before.trim();
  if (beforeTrimmed) noteParts.push(beforeTrimmed);
  if (droppedSelectors.size > 0) {
    noteParts.push(
      `Sélecteur(s) ignoré(s) car hors de la sélection : ${[...droppedSelectors].join(', ')}.`,
    );
  }

  if (overrides.length === 0) return { error: NOTHING_USABLE };

  const note = noteParts.join(' ').trim();
  return note ? { overrides, note: note.slice(0, MAX_NOTE_LENGTH) } : { overrides };
}
