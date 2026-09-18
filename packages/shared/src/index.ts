export * from './extension-messages.js';
export * from './agent.js';
export * from './overrides.js';

export const DEFAULT_PORT = 7331;

export interface ElementContext {
  selector: string;
  tagName: string;
  id?: string;
  classes: string[];
  textContent: string;
  outerHtml: string;
  domPath: string[];
  rect: { x: number; y: number; width: number; height: number };
  computedStyles: Record<string, string>;
  pageUrl: string;
}

export type AgentKind = 'codex' | 'claude';

export type AgentEvent =
  | { type: 'started'; agent: AgentKind }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; detail?: string }
  | { type: 'done'; exitCode: number }
  | { type: 'error'; message: string };

export interface FileDiff {
  path: string;
  status: 'modified' | 'added' | 'deleted';
  patch: string;
}

export type ClientMessage =
  | { type: 'run'; agent: AgentKind; prompt: string; element: ElementContext }
  | { type: 'accept' }
  | { type: 'reject' }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'hello'; version: string; cwd: string; agents: AgentKind[] }
  | { type: 'event'; event: AgentEvent }
  | { type: 'diff'; files: FileDiff[] }
  | { type: 'restored'; files: string[] }
  | { type: 'pong' }
  | { type: 'error'; message: string };
