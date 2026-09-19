import type { AgentEvent, AgentRunner, RunMode, RunRequest } from '@vizion/shared';
import { appendScreenshotNote, buildOverlayPrompt, buildPrompt } from '../prompt.js';
import { isCommandAvailable, spawnCli } from './spawn.js';

const COMMAND = 'codex';

interface CodexItemLike {
  type?: unknown;
  text?: unknown;
  command?: unknown;
  path?: unknown;
}

interface CodexEnvelope {
  type?: unknown;
  item?: CodexItemLike;
  msg?: CodexItemLike;
  exit_code?: unknown;
  code?: unknown;
  message?: unknown;
  error?: unknown;
}

const TOOL_LIKE_TYPES = new Set([
  'command_execution',
  'file_change',
  'tool_call',
  'function_call',
  'patch_apply',
]);

const DONE_TYPES = new Set(['turn_completed', 'turn.completed', 'task_complete']);

/**
 * Parses a single line of `codex exec --json` output into zero or more
 * `AgentEvent`s. `codex` is not installed in this environment, so this is
 * implemented leniently from the documented `codex exec --json` JSONL
 * interface (an envelope with a `type`/`item.type`/`msg.type` discriminator)
 * rather than against captured real output:
 * - an item of type `agent_message` -> text
 * - `command_execution` / `file_change` / other tool-like items -> tool
 * - a turn-completed / error envelope -> done / error
 * - a non-JSON line -> text, with the raw line (never dropped silently)
 */
export function parseCodexLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let obj: CodexEnvelope;
  try {
    obj = JSON.parse(trimmed) as CodexEnvelope;
  } catch {
    return [{ type: 'text', text: trimmed }];
  }

  const item: CodexItemLike =
    obj.item ?? obj.msg ?? (obj as unknown as CodexItemLike);
  const itemType = typeof item.type === 'string' ? item.type : undefined;
  const envelopeType = typeof obj.type === 'string' ? obj.type : undefined;

  if (itemType === 'agent_message') {
    const text = typeof item.text === 'string' ? item.text : '';
    return text ? [{ type: 'text', text }] : [];
  }

  if (itemType === 'error' || envelopeType === 'error') {
    const message =
      (typeof obj.message === 'string' && obj.message) ||
      (typeof obj.error === 'string' && obj.error) ||
      (typeof item.text === 'string' && item.text) ||
      'codex reported an error';
    return [{ type: 'error', message }];
  }

  if (
    (itemType && DONE_TYPES.has(itemType)) ||
    (envelopeType && DONE_TYPES.has(envelopeType))
  ) {
    const exitCode =
      typeof obj.exit_code === 'number'
        ? obj.exit_code
        : typeof obj.code === 'number'
          ? obj.code
          : 0;
    return [{ type: 'done', exitCode }];
  }

  const command = typeof item.command === 'string' ? item.command : undefined;
  const path = typeof item.path === 'string' ? item.path : undefined;
  const isToolLike = (itemType && TOOL_LIKE_TYPES.has(itemType)) || command !== undefined || path !== undefined;

  if (isToolLike) {
    return [{ type: 'tool', name: itemType ?? 'tool', detail: command ?? path }];
  }

  return [];
}

/**
 * Builds the `codex exec` argv (minus the leading `exec --json`). Overlay
 * mode runs in a throwaway directory and must not touch it, so it uses a
 * read-only sandbox instead of `--full-auto` — and since that directory is
 * also a fresh, non-git temp dir, `--skip-git-repo-check` is required too,
 * or codex refuses to run at all ("Not inside a trusted directory").
 * When `screenshotPath` is set, `--image <path>` is added so codex attaches
 * the capture alongside the text prompt.
 */
export function buildCodexArgs(cwd: string, readOnly: boolean | undefined, screenshotPath?: string): string[] {
  const autoArgs = readOnly ? ['--sandbox', 'read-only', '--skip-git-repo-check'] : ['--full-auto'];
  const imageArgs = screenshotPath ? ['--image', screenshotPath] : [];
  return ['exec', '--json', ...autoArgs, ...imageArgs, '-C', cwd, '-'];
}

export class CodexRunner implements AgentRunner {
  readonly kind = 'codex' as const;

  isAvailable(): Promise<boolean> {
    return isCommandAvailable(COMMAND);
  }

  async *run(
    req: RunRequest & { cwd: string; mode?: RunMode; readOnly?: boolean; screenshotPath?: string },
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const basePrompt = req.mode === 'overlay' ? buildOverlayPrompt(req, req.cwd) : buildPrompt(req, req.cwd);
    const prompt = req.screenshotPath ? appendScreenshotNote(basePrompt, req.screenshotPath) : basePrompt;
    // Per the documented `codex exec` interface: --json for JSONL output,
    // -C to set the project directory, and a trailing `-` positional prompt
    // so codex reads the task from stdin instead of argv (see
    // buildCodexArgs for the auto/sandbox/image flags).
    const args = buildCodexArgs(req.cwd, req.readOnly, req.screenshotPath);

    let sawDone = false;
    let stderrText = '';

    for await (const item of spawnCli(COMMAND, args, { cwd: req.cwd, signal, stdin: prompt })) {
      switch (item.type) {
        case 'stdout': {
          const events = parseCodexLine(item.line);
          for (const event of events) {
            if (event.type === 'done') sawDone = true;
            yield event;
          }
          break;
        }
        case 'stderr':
          stderrText = item.text;
          break;
        case 'error':
          yield { type: 'error', message: item.message };
          return;
        case 'exit':
          if (!sawDone) {
            yield item.code === 0
              ? { type: 'done', exitCode: 0 }
              : {
                  type: 'error',
                  message: `codex exited with code ${item.code ?? 'null'}${
                    stderrText.trim() ? `: ${stderrText.trim()}` : ''
                  }`,
                };
          }
          return;
        default:
          break;
      }
    }
  }
}
