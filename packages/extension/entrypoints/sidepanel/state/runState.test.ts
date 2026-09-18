import { describe, expect, it } from 'vitest';
import type { FileDiff, ServerMessage } from '@vizion/shared';
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
});
