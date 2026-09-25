import type { Override } from '@vizion/shared';

/**
 * Undo/redo history of a list — a page's overrides by default, or the marks
 * drawn on a staged capture — as three stacks of snapshots: `past` (older
 * states, oldest first), the `present` list (the one currently in effect)
 * and `future` (states undone away from, most recent first). Pure and
 * framework-agnostic so it can be unit tested in isolation and reused by
 * both the override store and any UI that shows undo/redo counts.
 */
export interface HistoryState<T = Override> {
  past: T[][];
  present: T[];
  future: T[][];
}

/** Past entries beyond this age are dropped, oldest first. */
const MAX_PAST = 50;

/** `T` is never inferred from `present` (an empty `[]` would make it `never`): it is `Override` unless given. */
export function createHistory<T = Override>(present: NoInfer<T>[] = []): HistoryState<T> {
  return { past: [], present, future: [] };
}

/**
 * Records a move to `next`: the current `present` is pushed onto `past`
 * (capped at `MAX_PAST` entries) and `future` is cleared, since a fresh
 * change invalidates whatever could previously be redone.
 */
export function push<T>(state: HistoryState<T>, next: T[]): HistoryState<T> {
  const past = [...state.past, state.present].slice(-MAX_PAST);
  return { past, present: next, future: [] };
}

/** Steps back to the previous `present`, or returns `state` unchanged if there is none. */
export function undo<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.past.length === 0) return state;
  const present = state.past[state.past.length - 1]!;
  const past = state.past.slice(0, -1);
  const future = [state.present, ...state.future];
  return { past, present, future };
}

/** Steps forward to the next `future` entry, or returns `state` unchanged if there is none. */
export function redo<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.future.length === 0) return state;
  const present = state.future[0]!;
  const future = state.future.slice(1);
  const past = [...state.past, state.present].slice(-MAX_PAST);
  return { past, present, future };
}
