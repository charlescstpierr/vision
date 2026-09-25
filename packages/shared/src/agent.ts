import type { AgentEvent, AgentKind, ElementContext } from './index.js';

/**
 * A request to run an agent against a selected DOM element, as sent by the
 * extension side panel (see docs/PLAN.md 3.2/3.3).
 */
export interface RunRequest {
  agent: AgentKind;
  prompt: string;
  element: ElementContext;
  pageUrl: string;
}

/**
 * Uniform interface implemented by each agent CLI wrapper (Claude Code,
 * Codex, ...). `run` streams `AgentEvent`s as the underlying CLI produces
 * output; the returned iterable should stop (return) once a `done` or
 * `error` event has been yielded.
 */
export interface AgentRunner {
  readonly kind: AgentKind;
  isAvailable(): Promise<boolean>;
  run(req: RunRequest & { cwd: string; screenshotPath?: string }, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
