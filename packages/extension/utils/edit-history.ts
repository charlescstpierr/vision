import type { Override } from '@vizion/shared';

/**
 * Undo/redo history of a page's override list, as three stacks of
 * snapshots: `past` (older states, oldest first), the `present` list (the
 * one currently in effect) and `future` (states undone away from, most
 * recent first). Pure and framework-agnostic so it can be unit tested in
 * isolation and reused by both the override store and any UI that shows
 * undo/redo counts.
 */
export interface HistoryState {
  past: Override[][];
  present: Override[];
  future: Override[][];
}

/** Past entries beyond this age are dropped, oldest first. */
const MAX_PAST = 50;

export function createHistory(present: Override[] = []): HistoryState {
  return { past: [], present, future: [] };
}

/**
 * Records a move to `next`: the current `present` is pushed onto `past`
 * (capped at `MAX_PAST` entries) and `future` is cleared, since a fresh
 * change invalidates whatever could previously be redone.
 */
export function push(state: HistoryState, next: Override[]): HistoryState {
  const past = [...state.past, state.present].slice(-MAX_PAST);
  return { past, present: next, future: [] };
}

/** Steps back to the previous `present`, or returns `state` unchanged if there is none. */
export function undo(state: HistoryState): HistoryState {
  if (state.past.length === 0) return state;
  const present = state.past[state.past.length - 1]!;
  const past = state.past.slice(0, -1);
  const future = [state.present, ...state.future];
  return { past, present, future };
}

/** Steps forward to the next `future` entry, or returns `state` unchanged if there is none. */
export function redo(state: HistoryState): HistoryState {
  if (state.future.length === 0) return state;
  const present = state.future[0]!;
  const future = state.future.slice(1);
  const past = [...state.past, state.present].slice(-MAX_PAST);
  return { past, present, future };
}
