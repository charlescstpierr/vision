import type { AgentEvent, AgentKind, FileDiff, OverrideProposal, RunRecord, Screenshot, ServerMessage } from '@vizion/shared';
import type { Annotation } from '../../../utils/annotations.js';
import { createHistory, push, undo, type HistoryState } from '../../../utils/edit-history.js';

export interface RunState {
  running: boolean;
  agent: AgentKind | null;
  events: AgentEvent[];
  diff: FileDiff[] | null;
  decision: { runId: string; state: 'pending' | 'reject-only' | 'unavailable' } | null;
  error: string | null;
  exitCode: number | null;
  restoredFiles: string[] | null;
  /** Past agent runs reported by the server (`list-history`), newest first or not — the UI sorts. */
  runs: RunRecord[];
  /** Set on a `run-undone` server message, cleared when a new run starts. */
  undoNotice: string | null;
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
   * The capture attached to the current/last run, if any. While a run is
   * being composed this is a *staged* capture (not sent yet) — see
   * `screenshotSent`. Reset (to `null`) only via `set-screenshot`,
   * `discard-staged-screenshot` (staged captures only) or `clear`; `start`
   * deliberately leaves it alone so a staged capture carries into the run
   * it was taken for.
   */
  screenshot: Screenshot | null;
  /** Whether `screenshot` has actually been sent with a run. Set true on `start`, reset to false on `clear` / `set-screenshot`. */
  screenshotSent: boolean;
  /**
   * The marks drawn on `screenshot`, with their undo history. Editable only
   * while the capture is staged; flattened into the image only when the run
   * is sent, and kept afterwards to show what went out with it. Emptied
   * whenever the capture itself is replaced or dropped.
   */
  annotations: HistoryState<Annotation>;
}

/** Edits to the marks on the staged capture; ignored when no capture is staged. */
export type AnnotationAction =
  | { type: 'add-annotation'; annotation: Annotation }
  | { type: 'update-annotation'; index: number; annotation: Annotation }
  | { type: 'remove-annotation'; index: number }
  | { type: 'undo-annotation' }
  | { type: 'clear-annotations' };

export type RunAction =
  | { type: 'server'; message: ServerMessage }
  | { type: 'start'; agent: AgentKind; prompt: string; pageKey: string }
  | { type: 'clear' }
  | { type: 'clear-proposal' }
  | { type: 'proposal-error'; message: string }
  | { type: 'set-screenshot'; screenshot: Screenshot | null }
  /** The selection or page changed: a capture not sent yet no longer shows what a run would be about. */
  | { type: 'discard-staged-screenshot' }
  | AnnotationAction
  /** The WebSocket send for a `run` failed (server connection lost): the run is not running; report why. */
  | { type: 'send-failed' };

const NO_ANNOTATIONS: HistoryState<Annotation> = createHistory<Annotation>();

export const initialRunState: RunState = {
  running: false,
  agent: null,
  events: [],
  diff: null,
  decision: null,
  error: null,
  exitCode: null,
  restoredFiles: null,
  runs: [],
  undoNotice: null,
  pageKey: null,
  proposal: null,
  proposalError: null,
  screenshot: null,
  screenshotSent: false,
  annotations: NO_ANNOTATIONS,
};

function annotate(state: RunState, action: AnnotationAction): RunState {
  if (!state.screenshot || state.screenshotSent) return state;
  const history = state.annotations;
  const marks = history.present;
  switch (action.type) {
    case 'add-annotation':
      return { ...state, annotations: push(history, [...marks, action.annotation]) };
    case 'update-annotation':
      return {
        ...state,
        annotations: push(history, marks.map((mark, index) => (index === action.index ? action.annotation : mark))),
      };
    case 'remove-annotation':
      return { ...state, annotations: push(history, marks.filter((_, index) => index !== action.index)) };
    case 'undo-annotation':
      return history.past.length === 0 ? state : { ...state, annotations: undo(history) };
    case 'clear-annotations':
      return marks.length === 0 ? state : { ...state, annotations: push(history, []) };
  }
}

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'start':
      return {
        ...state,
        running: true,
        agent: action.agent,
        events: [],
        diff: null,
        decision: null,
        error: null,
        exitCode: null,
        restoredFiles: null,
        undoNotice: null,
        pageKey: action.pageKey,
        proposal: null,
        proposalError: null,
        screenshotSent: true,
      };
    case 'clear':
      return initialRunState;
    case 'clear-proposal':
      return { ...state, proposal: null, proposalError: null };
    case 'proposal-error':
      return { ...state, proposalError: action.message };
    case 'set-screenshot':
      return { ...state, screenshot: action.screenshot, screenshotSent: false, annotations: NO_ANNOTATIONS };
    case 'discard-staged-screenshot':
      return state.screenshot && !state.screenshotSent
        ? { ...state, screenshot: null, annotations: NO_ANNOTATIONS }
        : state;
    case 'add-annotation':
    case 'update-annotation':
    case 'remove-annotation':
    case 'undo-annotation':
    case 'clear-annotations':
      return annotate(state, action);
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
          if (message.state === 'resolved') {
            return state.decision?.runId === message.runId
              ? { ...state, decision: null, diff: null, error: null, running: false }
              : state;
          }
          return {
            ...state,
            decision: { runId: message.runId, state: message.state },
            diff: message.files,
            error: null,
            running: false,
            restoredFiles: null,
          };
        case 'overlay-proposal':
          return {
            ...state,
            proposal: { overrides: message.overrides, note: message.note, pageKey: state.pageKey ?? '' },
          };
        case 'restored':
          return { ...state, restoredFiles: message.files };
        case 'error':
          return {
            ...state,
            running: false,
            error: message.paths?.length ? `${message.message} (${message.paths.join(', ')})` : message.message,
            decision: message.code === 'diff-unavailable' && message.runId
              ? { runId: message.runId, state: 'unavailable' }
              : message.code === 'reject-only' && message.runId
                ? { runId: message.runId, state: 'reject-only' }
                : state.decision,
          };
        case 'history':
          return { ...state, runs: message.runs };
        case 'run-undone':
          return {
            ...state,
            runs: state.runs.map((run) =>
              run.id === message.id ? { ...run, status: 'undone' as const } : run,
            ),
            undoNotice: `Run annulé : ${message.files.length} fichier(s) restauré(s)`,
            // Undoing a run resolves whatever error state led to it (e.g. a
            // reviewer rejecting a bad run), so any stale error banner should
            // clear along with it.
            error: null,
          };
        case 'hello':
          // The server replays its pending decision after hello. Until that
          // replay, no decision from a previous connection is authoritative.
          return { ...state, decision: null, diff: null, error: null, running: false };
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
