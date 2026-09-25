import { describe, expect, it } from 'vitest';
import type { FileDiff, OverrideProposal, RunRecord, Screenshot, ServerMessage } from '@vizion/shared';
import type { Annotation } from '../../../utils/annotations.js';
import { initialRunState, runReducer, type RunState } from './runState.js';

const PAGE_KEY = 'https://example.com/page';

function start(state: RunState = initialRunState, pageKey = PAGE_KEY): RunState {
  return runReducer(state, { type: 'start', agent: 'codex', prompt: 'do it', pageKey });
}

describe('runReducer', () => {
  it('start resets state and marks running', () => {
    const state = start();
    expect(state).toEqual({
      running: true,
      agent: 'codex',
      events: [],
      diff: null,
      decision: null,
      error: null,
      exitCode: null,
      restoredFiles: null,
      runs: [],
      undoNotice: null,
      pageKey: PAGE_KEY,
      proposal: null,
      proposalError: null,
      screenshot: null,
      screenshotSent: true,
      annotations: { past: [], present: [], future: [] },
    });
  });

  it('start records the page key the run is bound to', () => {
    const state = start(initialRunState, 'https://example.com/other');
    expect(state.pageKey).toBe('https://example.com/other');
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
    state = runReducer(state, { type: 'server', message: { type: 'diff', runId: 'run-1', state: 'pending', files } });
    expect(state.diff).toEqual(files);
    expect(state.decision).toEqual({ runId: 'run-1', state: 'pending' });
  });

  it('restored message records the restored file list', () => {
    let state = start();
    state = runReducer(state, { type: 'server', message: { type: 'restored', files: ['a.ts', 'b.ts'] } });
    expect(state.restoredFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('start resets restoredFiles from a previous reject', () => {
    let state = start();
    state = runReducer(state, { type: 'server', message: { type: 'restored', files: ['a.ts'] } });
    state = runReducer(state, { type: 'start', agent: 'codex', prompt: 'again', pageKey: PAGE_KEY });
    expect(state.restoredFiles).toBeNull();
  });

  it('hello clears a stale decision before the server replays its current one', () => {
    const before = start();
    const afterHello = runReducer(before, {
      type: 'server',
      message: { type: 'hello', version: '0.0.0', cwd: '/tmp', agents: [] },
    });
    expect(afterHello.running).toBe(false);
    expect(afterHello.decision).toBeNull();
    const afterPong = runReducer(before, { type: 'server', message: { type: 'pong' } });
    expect(afterPong).toEqual(before);
  });

  it('replays a pending decision after reconnect and clears it only when resolved', () => {
    const files: FileDiff[] = [{ path: 'a.ts', status: 'modified', patch: 'patch' }];
    let state = runReducer(initialRunState, {
      type: 'server', message: { type: 'diff', runId: 'first', state: 'pending', files },
    });
    state = runReducer(state, {
      type: 'server', message: { type: 'hello', version: '0.0.0', cwd: '/tmp', agents: [] },
    });
    expect(state.decision).toBeNull();
    state = runReducer(state, {
      type: 'server', message: { type: 'diff', runId: 'first', state: 'pending', files },
    });
    state = runReducer(state, {
      type: 'server', message: { type: 'error', runId: 'first', code: 'reject-only', message: 'restore failed' },
    });
    expect(state.decision).toEqual({ runId: 'first', state: 'reject-only' });
    state = runReducer(state, {
      type: 'server', message: { type: 'diff', runId: 'other', state: 'resolved', files: [] },
    });
    expect(state.decision?.runId).toBe('first');
    state = runReducer(state, {
      type: 'server', message: { type: 'diff', runId: 'first', state: 'resolved', files: [] },
    });
    expect(state.decision).toBeNull();
    expect(state.diff).toBeNull();
  });

  it('keeps a retryable unavailable diff and displays oversized dirty paths', () => {
    let state = runReducer(initialRunState, {
      type: 'server', message: { type: 'error', runId: 'first', code: 'diff-unavailable', message: 'Git inaccessible' },
    });
    expect(state.decision).toEqual({ runId: 'first', state: 'unavailable' });
    state = runReducer(state, {
      type: 'server', message: { type: 'error', code: 'snapshot-too-large', paths: ['large.bin'], message: 'Run refusé' },
    });
    expect(state.decision?.runId).toBe('first');
    expect(state.error).toContain('large.bin');
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
    expect(state.proposal).toEqual({ overrides, note: 'Ceci devrait aider', pageKey: PAGE_KEY });
  });

  it('tags the proposal with the page key captured at start, not any later one', () => {
    const overrides: OverrideProposal[] = [{ selector: '#hero', kind: 'text', value: 'Bonjour' }];
    let state = start(initialRunState, 'https://example.com/a');
    state = runReducer(state, { type: 'server', message: { type: 'overlay-proposal', overrides } });
    expect(state.proposal?.pageKey).toBe('https://example.com/a');
  });

  it('proposal-error records a message but keeps the proposal', () => {
    const overrides: OverrideProposal[] = [{ selector: '#hero', kind: 'text', value: 'Bonjour' }];
    let state = start();
    state = runReducer(state, { type: 'server', message: { type: 'overlay-proposal', overrides } });
    state = runReducer(state, { type: 'proposal-error', message: 'quota dépassé' });
    expect(state.proposal).not.toBeNull();
    expect(state.proposalError).toBe('quota dépassé');
  });

  it('clear-proposal also clears a pending proposal error', () => {
    let state = runReducer(initialRunState, { type: 'proposal-error', message: 'boom' });
    state = runReducer(state, { type: 'clear-proposal' });
    expect(state.proposalError).toBeNull();
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

  it('set-screenshot stores the captured screenshot', () => {
    const screenshot: Screenshot = { dataUrl: 'data:image/jpeg;base64,abc', width: 120, height: 80 };
    let state = start();
    state = runReducer(state, { type: 'set-screenshot', screenshot });
    expect(state.screenshot).toEqual(screenshot);
  });

  it('set-screenshot with null removes a previously stored screenshot', () => {
    const screenshot: Screenshot = { dataUrl: 'data:image/jpeg;base64,abc', width: 120, height: 80 };
    let state = start();
    state = runReducer(state, { type: 'set-screenshot', screenshot });
    state = runReducer(state, { type: 'set-screenshot', screenshot: null });
    expect(state.screenshot).toBeNull();
  });

  it('starting a new run keeps a staged screenshot and marks it sent', () => {
    const screenshot: Screenshot = { dataUrl: 'data:image/jpeg;base64,abc', width: 120, height: 80 };
    let state = start();
    state = runReducer(state, { type: 'set-screenshot', screenshot });
    expect(state.screenshotSent).toBe(false);
    state = start(state);
    expect(state.screenshot).toEqual(screenshot);
    expect(state.screenshotSent).toBe(true);
  });

  it('set-screenshot resets screenshotSent to false', () => {
    let state = start();
    expect(state.screenshotSent).toBe(true);
    state = runReducer(state, { type: 'set-screenshot', screenshot: null });
    expect(state.screenshotSent).toBe(false);
  });

  it('clear resets the screenshot and screenshotSent', () => {
    const screenshot: Screenshot = { dataUrl: 'data:image/jpeg;base64,abc', width: 120, height: 80 };
    let state = start();
    state = runReducer(state, { type: 'set-screenshot', screenshot });
    state = start(state);
    state = runReducer(state, { type: 'clear' });
    expect(state.screenshot).toBeNull();
    expect(state.screenshotSent).toBe(false);
  });

  it('send-failed stops the run and reports the connection loss in French', () => {
    let state = start();
    state = runReducer(state, { type: 'send-failed' });
    expect(state.running).toBe(false);
    expect(state.error).toBe('Connexion au serveur perdue, run non envoyé.');
  });

  it('send-failed leaves a staged screenshot untouched', () => {
    const screenshot: Screenshot = { dataUrl: 'data:image/jpeg;base64,abc', width: 120, height: 80 };
    let state = start();
    state = runReducer(state, { type: 'set-screenshot', screenshot });
    state = runReducer(state, { type: 'send-failed' });
    expect(state.screenshot).toEqual(screenshot);
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

describe('runReducer annotations', () => {
  const SHOT: Screenshot = { dataUrl: 'data:image/jpeg;base64,abc', width: 120, height: 80 };
  const ARROW: Annotation = { tool: 'arrow', from: { x: 10, y: 70 }, to: { x: 60, y: 20 } };
  const CIRCLE: Annotation = { tool: 'circle', from: { x: 70, y: 10 }, to: { x: 110, y: 50 } };

  /** A staged (not yet sent) capture with `marks` drawn on it, one at a time. */
  function staged(...marks: Annotation[]): RunState {
    let state = runReducer(initialRunState, { type: 'set-screenshot', screenshot: SHOT });
    for (const annotation of marks) {
      state = runReducer(state, { type: 'add-annotation', annotation });
    }
    return state;
  }

  it('add-annotation draws marks on the staged capture in order', () => {
    expect(staged(ARROW, CIRCLE).annotations.present).toEqual([ARROW, CIRCLE]);
  });

  it('undo-annotation takes back only the last mark', () => {
    const state = runReducer(staged(ARROW, CIRCLE), { type: 'undo-annotation' });
    expect(state.annotations.present).toEqual([ARROW]);
  });

  it('undo-annotation puts an edited mark back the way it was', () => {
    const moved: Annotation = { ...ARROW, to: { x: 90, y: 40 } };
    let state = runReducer(staged(ARROW), { type: 'update-annotation', index: 0, annotation: moved });
    expect(state.annotations.present).toEqual([moved]);
    state = runReducer(state, { type: 'undo-annotation' });
    expect(state.annotations.present).toEqual([ARROW]);
  });

  it('undo-annotation with nothing left to undo is a no-op', () => {
    const state = staged();
    expect(runReducer(state, { type: 'undo-annotation' })).toBe(state);
  });

  it('remove-annotation deletes only the chosen mark', () => {
    const state = runReducer(staged(ARROW, CIRCLE), { type: 'remove-annotation', index: 0 });
    expect(state.annotations.present).toEqual([CIRCLE]);
  });

  it('clear-annotations removes every mark but keeps the capture staged', () => {
    const state = runReducer(staged(ARROW, CIRCLE), { type: 'clear-annotations' });
    expect(state.annotations.present).toEqual([]);
    expect(state.screenshot).toEqual(SHOT);
    expect(state.screenshotSent).toBe(false);
  });

  it('a clear can itself be undone, bringing every mark back', () => {
    let state = runReducer(staged(ARROW, CIRCLE), { type: 'clear-annotations' });
    state = runReducer(state, { type: 'undo-annotation' });
    expect(state.annotations.present).toEqual([ARROW, CIRCLE]);
  });

  it('ignores annotation edits when no capture is staged', () => {
    expect(runReducer(initialRunState, { type: 'add-annotation', annotation: ARROW })).toBe(initialRunState);
  });

  it('keeps the marks a capture was sent with, and ignores edits once the run started', () => {
    const sent = start(staged(ARROW));
    expect(sent.screenshotSent).toBe(true);
    expect(sent.annotations.present).toEqual([ARROW]);
    expect(runReducer(sent, { type: 'add-annotation', annotation: CIRCLE })).toBe(sent);
    expect(runReducer(sent, { type: 'undo-annotation' })).toBe(sent);
    expect(runReducer(sent, { type: 'clear-annotations' })).toBe(sent);
  });

  it('a new capture starts with no marks and nothing to undo', () => {
    const retaken: Screenshot = { ...SHOT, dataUrl: 'data:image/jpeg;base64,def' };
    const state = runReducer(staged(ARROW), { type: 'set-screenshot', screenshot: retaken });
    expect(state.annotations.present).toEqual([]);
    expect(state.annotations.past).toEqual([]);
  });

  it('discard-staged-screenshot drops an unsent capture together with its marks', () => {
    const state = runReducer(staged(ARROW), { type: 'discard-staged-screenshot' });
    expect(state.screenshot).toBeNull();
    expect(state.annotations.present).toEqual([]);
  });

  it('discard-staged-screenshot keeps a capture already sent with a run', () => {
    const sent = start(staged(ARROW));
    expect(runReducer(sent, { type: 'discard-staged-screenshot' })).toBe(sent);
  });
});
