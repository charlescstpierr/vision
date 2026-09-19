import type { AgentKind, AgentRunner } from '@vizion/shared';
import { ClaudeRunner } from './claude.js';
import { CodexRunner } from './codex.js';

export function createRunners(): AgentRunner[] {
  return [new ClaudeRunner(), new CodexRunner()];
}

export async function detectAvailableAgents(runners: AgentRunner[]): Promise<AgentKind[]> {
  const results = await Promise.all(
    runners.map(async (runner) => ((await runner.isAvailable()) ? runner.kind : null)),
  );
  return results.filter((kind): kind is AgentKind => kind !== null);
}

export { ClaudeRunner, parseClaudeLine } from './claude.js';
export { CodexRunner, parseCodexLine } from './codex.js';
export { isCommandAvailable, spawnCli } from './spawn.js';
