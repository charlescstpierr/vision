export * from './extension-messages.js';
export * from './agent.js';
export * from './overrides.js';
export * from './pairing.js';

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
  /** `file:line:column` from a `data-vizion-source` build annotation, when present. */
  sourceLocation?: string;
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

export type RunMode = 'source' | 'overlay';

/** A cropped capture of the selected element, produced by the side panel. */
export interface Screenshot {
  dataUrl: string;
  width: number;
  height: number;
}

/** An override suggested by the agent in overlay mode (no id / timestamp yet). */
export type OverrideProposal =
  | { selector: string; kind: 'style'; property: string; value: string }
  | { selector: string; kind: 'text'; value: string };

/** A past agent run, kept so it can be undone later. */
export interface RunRecord {
  id: string;
  agent: AgentKind;
  prompt: string;
  /** Selectors of the elements the run was about (one or more). */
  selectors: string[];
  createdAt: number;
  files: string[];
  status: 'applied' | 'undone';
}

export type ClientMessage =
  | {
      type: 'run';
      agent: AgentKind;
      prompt: string;
      /** Primary element (kept for compatibility); `elements` lists all selected ones. */
      element: ElementContext;
      elements?: ElementContext[];
      /**
       * 'source' (default): the agent edits the project files and a diff follows.
       * 'overlay': the agent runs in an empty temporary directory and proposes
       * overrides (styles / text) that the panel can apply on the page.
       */
      mode?: RunMode;
      /** Optional JPEG/PNG capture of the selected element(s), as a data URL (max ~2 MB). */
      screenshot?: Screenshot;
    }
  /** Aborts the run currently in flight, if any. Whatever the agent already wrote is kept, and undoable like any other run. */
  | { type: 'cancel' }
  /**
   * Reverts a run's files. Refused with `undo-conflict` when a touched file no
   * longer matches what the run left behind; `force` reverts it anyway,
   * discarding whatever changed it.
   */
  | { type: 'undo-run'; id: string; force?: boolean }
  | { type: 'list-history' }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'hello'; version: string; cwd: string; agents: AgentKind[] }
  | { type: 'event'; event: AgentEvent }
  /** The files a run changed. Informational: they are already on disk. */
  | { type: 'diff'; files: FileDiff[] }
  /** `undo-run` refused: these files changed since the run. Retry with `force` to revert anyway. */
  | { type: 'undo-conflict'; id: string; files: string[] }
  | { type: 'history'; runs: RunRecord[] }
  | { type: 'overlay-proposal'; overrides: OverrideProposal[]; note?: string }
  | { type: 'run-undone'; id: string; files: string[] }
  | { type: 'pong' }
  | { type: 'error'; message: string };
