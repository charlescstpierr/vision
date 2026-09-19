import type { AgentEvent, AgentRunner, RunMode, RunRequest } from '@vizion/shared';
import { appendScreenshotNote, buildOverlayPrompt, buildPrompt } from '../prompt.js';
import { isCommandAvailable, spawnCli } from './spawn.js';

const COMMAND = 'claude';

interface ClaudeContentBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: Record<string, unknown>;
}

interface ClaudeLine {
  type?: unknown;
  subtype?: unknown;
  message?: { content?: ClaudeContentBlock[] };
  is_error?: unknown;
  result?: unknown;
  error?: unknown;
}

function resultErrorMessage(obj: ClaudeLine): string {
  if (typeof obj.result === 'string' && obj.result.trim()) return obj.result;
  if (typeof obj.error === 'string' && obj.error.trim()) return obj.error;
  return 'Claude a terminé avec une erreur';
}

function toolDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.command === 'string') return input.command;
  return undefined;
}

/**
 * Parses a single line of `claude -p --output-format stream-json --verbose`
 * output into zero or more `AgentEvent`s. Verified against real CLI output:
 * - `{"type":"system","subtype":"init",...}` -> started
 * - `{"type":"assistant","message":{"content":[{"type":"text","text":...}]}}` -> text
 * - assistant content block `{"type":"tool_use","name":"Bash","input":{"command":...}}` -> tool
 * - `{"type":"result","is_error":false,...}` -> done
 * - `{"type":"result","is_error":true,...}` -> error (message from `result`/`error`, else a fallback)
 * Any line that isn't valid JSON, or doesn't match a known shape, is ignored.
 */
export function parseClaudeLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let obj: ClaudeLine;
  try {
    obj = JSON.parse(trimmed) as ClaudeLine;
  } catch {
    return [];
  }

  if (obj.type === 'system' && obj.subtype === 'init') {
    return [{ type: 'started', agent: 'claude' }];
  }

  const content = obj.message?.content;
  if (obj.type === 'assistant' && Array.isArray(content)) {
    const events: AgentEvent[] = [];
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        events.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        events.push({
          type: 'tool',
          name: typeof block.name === 'string' ? block.name : 'unknown',
          detail: toolDetail(block.input),
        });
      }
    }
    return events;
  }

  if (obj.type === 'result') {
    if (obj.is_error) {
      return [{ type: 'error', message: resultErrorMessage(obj) }];
    }
    return [{ type: 'done', exitCode: 0 }];
  }

  return [];
}

export class ClaudeRunner implements AgentRunner {
  readonly kind = 'claude' as const;

  isAvailable(): Promise<boolean> {
    return isCommandAvailable(COMMAND);
  }

  async *run(
    req: RunRequest & { cwd: string; mode?: RunMode; readOnly?: boolean; screenshotPath?: string },
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const basePrompt = req.mode === 'overlay' ? buildOverlayPrompt(req, req.cwd) : buildPrompt(req, req.cwd);
    const prompt = req.screenshotPath ? appendScreenshotNote(basePrompt, req.screenshotPath) : basePrompt;
    // --verbose is required by the CLI whenever --print is combined with
    // --output-format stream-json (verified: `claude -p --output-format
    // stream-json ...` without --verbose exits with "requires --verbose").
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
    // Overlay mode runs in a throwaway directory and must not touch it, so
    // block the tools that could write or execute.
    if (req.readOnly) {
      args.push('--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit');
    }

    let sawDone = false;
    let stderrText = '';

    for await (const item of spawnCli(COMMAND, args, { cwd: req.cwd, signal, stdin: prompt })) {
      switch (item.type) {
        case 'stdout': {
          const events = parseClaudeLine(item.line);
          for (const event of events) {
            if (event.type === 'done' || event.type === 'error') sawDone = true;
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
                  message: `claude exited with code ${item.code ?? 'null'}${
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
