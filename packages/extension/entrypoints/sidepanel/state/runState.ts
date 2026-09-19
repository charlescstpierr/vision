import type { AgentEvent, AgentKind, FileDiff, RunRecord, ServerMessage } from '@vizion/shared';

export interface RunState {
  running: boolean;
  agent: AgentKind | null;
  events: AgentEvent[];
  diff: FileDiff[] | null;
  error: string | null;
  exitCode: number | null;
  restoredFiles: string[] | null;
  /** Past agent runs reported by the server (`list-history`), newest first or not — the UI sorts. */
  runs: RunRecord[];
  /** Set on a `run-undone` server message, cleared when a new run starts. */
  undoNotice: string | null;
}

export type RunAction =
  | { type: 'server'; message: ServerMessage }
  | { type: 'start'; agent: AgentKind; prompt: string }
  | { type: 'clear' };

export const initialRunState: RunState = {
  running: false,
  agent: null,
  events: [],
  diff: null,
  error: null,
  exitCode: null,
  restoredFiles: null,
  runs: [],
  undoNotice: null,
};

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'start':
      return {
        ...state,
        running: true,
        agent: action.agent,
        events: [],
        diff: null,
        error: null,
        exitCode: null,
        restoredFiles: null,
        undoNotice: null,
      };
    case 'clear':
      return initialRunState;
    case 'server': {
      const message = action.message;
      switch (message.type) {
        case 'event': {
          const event = message.event;
          const events = [...state.events, event];
          if (event.type === 'done') {
            return { ...state, events, running: false, exitCode: event.exitCode };
          }
          if (event.type === 'error') {
            return { ...state, events, running: false, error: event.message };
          }
          return { ...state, events };
        }
        case 'diff':
          return { ...state, diff: message.files };
        case 'restored':
          return { ...state, restoredFiles: message.files };
        case 'error':
          return { ...state, running: false, error: message.message };
        case 'history':
          return { ...state, runs: message.runs };
        case 'run-undone':
          return {
            ...state,
            runs: state.runs.map((run) =>
              run.id === message.id ? { ...run, status: 'undone' as const } : run,
            ),
            undoNotice: `Run annulé : ${message.files.length} fichier(s) restauré(s)`,
          };
        case 'hello':
        case 'pong':
          return state;
        default:
          // Unknown ServerMessage variant (e.g. added concurrently by another
          // agent working on the server/shared packages): no-op.
          return state;
      }
    }
    default:
      return state;
  }
}
