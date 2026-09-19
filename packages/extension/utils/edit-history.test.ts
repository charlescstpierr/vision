import { describe, expect, it } from 'vitest';
import type { Override } from '@vizion/shared';
import { createHistory, push, redo, undo } from './edit-history.js';

function ov(id: string): Override {
  return { id, selector: '.x', kind: 'text', value: id, createdAt: 0 };
}

describe('edit-history', () => {
  it('push moves the previous present into past, sets the new present and clears future', () => {
    let state = createHistory([]);
    state = push(state, [ov('a')]);
    expect(state).toEqual({ past: [[]], present: [ov('a')], future: [] });

    state = push(state, [ov('a'), ov('b')]);
    expect(state).toEqual({ past: [[], [ov('a')]], present: [ov('a'), ov('b')], future: [] });
  });

  it('push clears any future left over from a previous undo', () => {
    let state = createHistory([]);
    state = push(state, [ov('a')]);
    state = undo(state);
    state = push(state, [ov('c')]);
    expect(state.future).toEqual([]);
  });

  it('undo restores the previous present and stashes the current one in future', () => {
    let state = createHistory([]);
    state = push(state, [ov('a')]);
    state = push(state, [ov('a'), ov('b')]);
    state = undo(state);
    expect(state.present).toEqual([ov('a')]);
    expect(state.future).toEqual([[ov('a'), ov('b')]]);
    expect(state.past).toEqual([[]]);
  });

  it('undo on an empty past is a no-op', () => {
    const state = createHistory([ov('a')]);
    expect(undo(state)).toEqual(state);
  });

  it('redo re-applies a future state and pushes the current present back to past', () => {
    let state = createHistory([]);
    state = push(state, [ov('a')]);
    state = undo(state);
    state = redo(state);
    expect(state).toEqual({ past: [[]], present: [ov('a')], future: [] });
  });

  it('redo on an empty future is a no-op', () => {
    const state = createHistory([ov('a')]);
    expect(redo(state)).toEqual(state);
  });

  it('caps past at 50 entries', () => {
    let state = createHistory([]);
    for (let i = 0; i < 60; i += 1) {
      state = push(state, [ov(String(i))]);
    }
    expect(state.past.length).toBe(50);
    // The oldest surviving entry is the present just before the push that
    // evicted the very first one (10 pushes happened before the cap kicked in).
    expect(state.past[0]).toEqual([ov('9')]);
    expect(state.present).toEqual([ov('59')]);
  });
});
