import type { AgentEvent, AgentKind, FileDiff, OverrideProposal, RunRecord, Screenshot, ServerMessage } from '@vizion/shared';

export interface RunState {
  running: boolean;
  agent: AgentKind | null;
  events: AgentEvent[];
  diff: FileDiff[] | null;
  error: string | null;
  exitCode: number | null;
  /** Past agent runs reported by the server (`list-history`), newest first or not — the UI sorts. */
  runs: RunRecord[];
  /** Set on a `run-undone` server message, cleared when a new run starts. */
  undoNotice: string | null;
  /**
   * Set when an `undo-run` was refused because a touched file no longer
   * matches what the run left behind. Kept so the history row can offer a
   * forced retry inline; cleared on `start`, `clear`, and `run-undone`
   * (the run it was about either got undone or the user moved on).
   */
  undoConflict: { id: string; files: string[] } | null;
  /**
   * The page key (`overrideKey(tabUrl)`, see `@vizion/shared`) of the tab the
   * current/last run was started against. Captured on `start` so an
   * `overlay-proposal` that arrives later can be tied to the page it was
   * actually generated for, regardless of which tab is active by the time it
   * arrives or is applied.
   */
  pageKey: string | null;
  /** Set on an `overlay-proposal` server message; cleared on `start` / `clear`. */
  proposal: { overrides: OverrideProposal[]; note?: string; pageKey: string } | null;
  /**
   * Set when applying the current proposal's overrides failed to persist
   * (see `proposal-error`). The proposal itself is kept so the user can
   * retry instead of losing it. Cleared on `clear-proposal` / `start` /
   * `clear`.
   */
  proposalError: string | null;
  /**
   * The capture sent with the current run, kept so the panel can show what
   * the agent was actually looking at. Every run carries one when the
   * capture succeeds, so there is no "staged but unsent" state to track.
   */
  screenshot: Screenshot | null;
}

export type RunAction =
  | { type: 'server'; message: ServerMessage }
  | { type: 'start'; agent: AgentKind; prompt: string; pageKey: string; screenshot: Screenshot | null }
  | { type: 'clear' }
  | { type: 'clear-proposal' }
  | { type: 'proposal-error'; message: string }
  /** The WebSocket send for a `run` failed (server connection lost): roll the run back to not-running. */
  | { type: 'send-failed' };

export const initialRunState: RunState = {
  running: false,
  agent: null,
  events: [],
  diff: null,
  error: null,
  exitCode: null,
  runs: [],
  undoNotice: null,
  undoConflict: null,
  pageKey: null,
  proposal: null,
  proposalError: null,
  screenshot: null,
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
        undoNotice: null,
        undoConflict: null,
        pageKey: action.pageKey,
        proposal: null,
        proposalError: null,
        screenshot: action.screenshot,
      };
    case 'clear':
      return initialRunState;
    case 'clear-proposal':
      return { ...state, proposal: null, proposalError: null };
    case 'proposal-error':
      return { ...state, proposalError: action.message };
    case 'send-failed':
      return { ...state, running: false, error: 'Connexion au serveur perdue, run non envoyé.' };
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
        case 'overlay-proposal':
          return {
            ...state,
            proposal: { overrides: message.overrides, note: message.note, pageKey: state.pageKey ?? '' },
          };
        case 'undo-conflict':
          return { ...state, undoConflict: { id: message.id, files: message.files } };
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
            // A resolved conflict no longer needs its "annuler quand même"
            // row, whichever way it got resolved (forced retry, or the user
            // undid a different, more recent run instead).
            undoConflict: null,
            // Undoing a run resolves whatever error state led to it (e.g. a
            // stale diff the user wanted gone), so any stale error banner
            // should clear along with it.
            error: null,
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
