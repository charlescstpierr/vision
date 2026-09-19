import type { OverrideProposal } from '@vizion/shared';

const NOTHING_USABLE = "L'agent n'a pas renvoyé de proposition exploitable.";
const MAX_NOTE_LENGTH = 300;

export type OverlayParseResult = { overrides: OverrideProposal[]; note?: string } | { error: string };

/**
 * The last top-level `[...]` array literal found anywhere in `text`, or
 * null. String state and bracket depth are tracked across the *entire*
 * scan (not reset per candidate `[`), so a `[` or `]` inside a quoted
 * value (e.g. `"value":"[done]"`) never starts or ends a spurious
 * candidate array.
 */
function findLastTopLevelArray(text: string): { start: number; end: number } | null {
  let result: { start: number; end: number } | null = null;
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
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
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ']') {
      if (depth > 0) {
        depth--;
        if (depth === 0) result = { start, end: i + 1 };
      }
    }
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

/** A text override's value may legitimately be empty (that's how text gets removed). */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** `color`, `-webkit-transform`, `--my-var`, but not `123`, `background:`, `on click`. */
const PROPERTY_RE = /^(--[a-z0-9-]+|-?[a-z][a-z0-9-]*)$/i;
/** Characters that would let a value break out of a single CSS declaration. */
const UNSAFE_VALUE_CHARS_RE = /[;{}<>\n]/;
/** Legacy CSS/JS injection vectors that don't need any of the chars above. */
const UNSAFE_VALUE_PATTERN_RE = /expression\s*\(|javascript:/i;

/**
 * Validates and sanitizes a proposed `{ property, value }` CSS declaration
 * so it can only ever render as a single, safe declaration: rejects
 * anything that isn't a plausible property name (custom properties like
 * `--x` allowed) or whose value could break out of the declaration or
 * inject script. `!important` is stripped rather than rejected, since the
 * applier adds its own. Returns null when the declaration is unsafe.
 */
function sanitizeStyleDeclaration(property: string, rawValue: string): string | null {
  if (!PROPERTY_RE.test(property)) return null;

  const value = rawValue.replace(/\s*!\s*important\s*$/i, '').trim();
  if (value.length === 0) return null;
  if (UNSAFE_VALUE_CHARS_RE.test(value)) return null;
  if (UNSAFE_VALUE_PATTERN_RE.test(value)) return null;

  return value;
}

/**
 * Parses an agent's overlay-mode reply into `OverrideProposal`s. Looks for
 * the last ```json fenced block in `text` (falling back to the last
 * top-level `[...]` array), validates each item, and drops anything whose
 * selector isn't in `allowedSelectors` or whose style declaration isn't a
 * single safe CSS declaration (mentioning it in `note`). Returns `{ error }`
 * when nothing usable was found.
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
  let droppedDeclarations = 0;

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
      const value = sanitizeStyleDeclaration(obj.property, obj.value);
      if (value === null) {
        droppedDeclarations++;
        continue;
      }
      overrides.push({ selector, kind: 'style', property: obj.property, value });
    } else if (obj.kind === 'text' && isString(obj.value)) {
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
  if (droppedDeclarations > 0) {
    noteParts.push(`Déclaration(s) de style invalide(s) ignorée(s) : ${droppedDeclarations}.`);
  }

  if (overrides.length === 0) return { error: NOTHING_USABLE };

  const note = noteParts.join(' ').trim();
  return note ? { overrides, note: note.slice(0, MAX_NOTE_LENGTH) } : { overrides };
}
