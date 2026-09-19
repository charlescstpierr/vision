import { describe, expect, it } from 'vitest';
import type { FileDiff, OverrideProposal, RunRecord, ServerMessage } from '@vizion/shared';
import { initialRunState, runReducer, type RunState } from './runState.js';

function start(state: RunState = initialRunState): RunState {
  return runReducer(state, { type: 'start', agent: 'codex', prompt: 'do it' });
}

describe('runReducer', () => {
  it('start resets state and marks running', () => {
    const state = start();
    expect(state).toEqual({
      running: true,
      agent: 'codex',
      events: [],
      diff: null,
      error: null,
      exitCode: null,
      restoredFiles: null,
      runs: [],
      undoNotice: null,
      proposal: null,
    });
  });

  it('appends text/tool/started events while keeping running true', () => {
    let state = start();
    state = runReducer(state, { type: 'server', message: { type: 'event', event: { type: 'started', agent: 'codex' } } });
    state = runReducer(state, { type: 'server', message: { type: 'event', event: { type: 'text', text: 'hi' } } });
    state = runReducer(state, { type: 'server', message: { type: 'event', event: { type: 'tool', name: 'edit', detail: 'file.ts' } } });
    expect(state.running).toBe(true);
    expect(state.events).toHaveLength(3);
  });

  it('done event stops running and records exit code', () => {
    let state = start();
    state = runReducer(state, { type: 'server', message: { type: 'event', event: { type: 'done', exitCode: 0 } } });
    expect(state.running).toBe(false);
    expect(state.exitCode).toBe(0);
    expect(state.events).toHaveLength(1);
  });

  it('error event (as an AgentEvent) stops running and sets error', () => {
    let state = start();
    state = runReducer(state, { type: 'server', message: { type: 'event', event: { type: 'error', message: 'boom' } } });
    expect(state.running).toBe(false);
    expect(state.error).toBe('boom');
  });

  it('a top-level server error message stops running and sets error', () => {
    let state = start();
    state = runReducer(state, { type: 'server', message: { type: 'error', message: 'not implemented yet' } });
    expect(state.running).toBe(false);
    expect(state.error).toBe('not implemented yet');
  });

  it('diff message sets the diff', () => {
    let state = start();
    const files: FileDiff[] = [{ path: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@' }];
    state = runReducer(state, { type: 'server', message: { type: 'diff', files } });
    expect(state.diff).toEqual(files);
  });

  it('restored message records the restored file list', () => {
    let state = start();
    state = runReducer(state, { type: 'server', message: { type: 'restored', files: ['a.ts', 'b.ts'] } });
    expect(state.restoredFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('start resets restoredFiles from a previous reject', () => {
    let state = start();
    state = runReducer(state, { type: 'server', message: { type: 'restored', files: ['a.ts'] } });
    state = runReducer(state, { type: 'start', agent: 'codex', prompt: 'again' });
    expect(state.restoredFiles).toBeNull();
  });

  it('hello and pong messages are no-ops', () => {
    const before = start();
    const afterHello = runReducer(before, {
      type: 'server',
      message: { type: 'hello', version: '0.0.0', cwd: '/tmp', agents: [] },
    });
    expect(afterHello).toEqual(before);
    const afterPong = runReducer(before, { type: 'server', message: { type: 'pong' } });
    expect(afterPong).toEqual(before);
  });

  it('unknown ServerMessage types are a no-op (forward compatibility)', () => {
    const before = start();
    const unknown = { type: 'something-new-from-the-server' } as unknown as ServerMessage;
    const after = runReducer(before, { type: 'server', message: unknown });
    expect(after).toEqual(before);
  });

  it('clear resets to the initial state', () => {
    const state = start();
    expect(runReducer(state, { type: 'clear' })).toEqual(initialRunState);
  });

  it('history message stores the run list', () => {
    const runs: RunRecord[] = [
      { id: '1', agent: 'codex', prompt: 'do it', selectors: ['#a'], createdAt: 1, files: ['a.ts'], status: 'accepted' },
    ];
    const state = runReducer(initialRunState, { type: 'server', message: { type: 'history', runs } });
    expect(state.runs).toEqual(runs);
  });

  it('run-undone marks the matching run as undone and sets a notice', () => {
    const runs: RunRecord[] = [
      { id: '1', agent: 'codex', prompt: 'do it', selectors: ['#a'], createdAt: 1, files: ['a.ts'], status: 'accepted' },
      { id: '2', agent: 'claude', prompt: 'do more', selectors: ['#b'], createdAt: 2, files: ['b.ts'], status: 'accepted' },
    ];
    let state = runReducer(initialRunState, { type: 'server', message: { type: 'history', runs } });
    state = runReducer(state, {
      type: 'server',
      message: { type: 'run-undone', id: '1', files: ['a.ts', 'b.ts'] },
    });
    expect(state.runs.find((r) => r.id === '1')?.status).toBe('undone');
    expect(state.runs.find((r) => r.id === '2')?.status).toBe('accepted');
    expect(state.undoNotice).toBe('Run annulé : 2 fichier(s) restauré(s)');
  });

  it('run-undone clears a stale error from a previous run', () => {
    let state = runReducer(initialRunState, {
      type: 'server',
      message: { type: 'error', message: 'boom' },
    });
    expect(state.error).toBe('boom');
    state = runReducer(state, {
      type: 'server',
      message: { type: 'run-undone', id: '1', files: ['a.ts'] },
    });
    expect(state.error).toBeNull();
    expect(state.undoNotice).toBe('Run annulé : 1 fichier(s) restauré(s)');
  });

  it('starting a new run clears any previous undo notice', () => {
    let state = runReducer(initialRunState, {
      type: 'server',
      message: { type: 'run-undone', id: '1', files: ['a.ts'] },
    });
    expect(state.undoNotice).not.toBeNull();
    state = start(state);
    expect(state.undoNotice).toBeNull();
  });

  it('overlay-proposal message stores the proposed overrides and note', () => {
    const overrides: OverrideProposal[] = [
      { selector: '#hero', kind: 'style', property: 'color', value: 'red' },
    ];
    let state = start();
    state = runReducer(state, {
      type: 'server',
      message: { type: 'overlay-proposal', overrides, note: 'Ceci devrait aider' },
    });
    expect(state.proposal).toEqual({ overrides, note: 'Ceci devrait aider' });
  });

  it('starting a new run clears a previous proposal', () => {
    const overrides: OverrideProposal[] = [{ selector: '#hero', kind: 'text', value: 'Bonjour' }];
    let state = runReducer(initialRunState, {
      type: 'server',
      message: { type: 'overlay-proposal', overrides },
    });
    expect(state.proposal).not.toBeNull();
    state = start(state);
    expect(state.proposal).toBeNull();
  });

  it('clear resets the proposal', () => {
    const overrides: OverrideProposal[] = [{ selector: '#hero', kind: 'text', value: 'Bonjour' }];
    let state = runReducer(initialRunState, {
      type: 'server',
      message: { type: 'overlay-proposal', overrides },
    });
    state = runReducer(state, { type: 'clear' });
    expect(state.proposal).toBeNull();
  });

  it('clear-proposal clears only the proposal, leaving the rest of the state intact', () => {
    const overrides: OverrideProposal[] = [{ selector: '#hero', kind: 'text', value: 'Bonjour' }];
    let state = start();
    state = runReducer(state, { type: 'server', message: { type: 'overlay-proposal', overrides } });
    state = runReducer(state, { type: 'clear-proposal' });
    expect(state.proposal).toBeNull();
    expect(state.running).toBe(true);
  });
});
