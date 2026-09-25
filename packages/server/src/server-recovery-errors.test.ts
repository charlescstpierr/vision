import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fixture, runMessage, signal, startRun, writeChange } from './recovery-fixture.js';
import * as snapshot from './snapshot.js';

describe('decision failures', () => {
  it('retains a retryable decision when accepting fails to capture undo bytes', async () => {
    // Given an unreadable after-side (a directory instead of the changed file).
    await using test = await fixture(writeChange);
    const client = await test.connect();
    const diff = await startRun(client);
    const file = path.join(test.cwd, 'tracked.txt');
    await fs.rm(file);
    await fs.mkdir(file);
    // When accept encounters the filesystem failure.
    client.send({ type: 'accept', runId: diff.runId });
    expect((await client.next()).type).toBe('error');
    await client.close();
    const recovered = await test.connect();
    // Then reconnect offers the same decision, which can be retried.
    expect(await recovered.next()).toEqual(diff);
    await fs.rmdir(file);
    await writeChange(test.cwd);
    recovered.send({ type: 'accept', runId: diff.runId });
    expect(await recovered.next()).toMatchObject({ type: 'diff', state: 'resolved', runId: diff.runId });
    const history = await recovered.next();
    if (history.type !== 'history') throw new Error('expected history');
    expect(history.runs).toHaveLength(1);
  });

  it('permits only reject retry when restoration has partially failed', async () => {
    // Given two dirty files with saved user bytes and a failing second restore.
    await using test = await fixture(async (cwd) => {
      await fs.writeFile(path.join(cwd, 'a.txt'), 'agent a');
      await fs.writeFile(path.join(cwd, 'z.txt'), 'agent z');
    });
    await fs.writeFile(path.join(test.cwd, 'a.txt'), 'user a');
    await fs.writeFile(path.join(test.cwd, 'z.txt'), 'user z');
    const client = await test.connect();
    const diff = await startRun(client);
    const blocked = path.join(test.cwd, 'z.txt');
    await fs.rm(blocked);
    await fs.mkdir(blocked);
    // When the first reject partially restores then fails.
    client.send({ type: 'reject', runId: diff.runId });
    expect((await client.next()).type).toBe('error');
    await client.close();
    const recovered = await test.connect();
    // Then it cannot be accepted, but the original restore set can be retried.
    expect(await recovered.next()).toMatchObject({ type: 'diff', runId: diff.runId, state: 'reject-only' });
    recovered.send({ type: 'accept', runId: diff.runId });
    expect((await recovered.next()).type).toBe('error');
    await fs.rmdir(blocked);
    recovered.send({ type: 'reject', runId: diff.runId });
    expect((await recovered.next()).type).toBe('restored');
    expect(await fs.readFile(path.join(test.cwd, 'a.txt'), 'utf8')).toBe('user a');
    expect(await fs.readFile(blocked, 'utf8')).toBe('user z');
  });

  it('retains the snapshot and blocks mutation when diff computation fails', async () => {
    // Given a real Git failure after the runner writes its changes.
    await using test = await fixture(async (cwd) => {
      await writeChange(cwd);
      await fs.rename(path.join(cwd, '.git'), path.join(cwd, '.git-held'));
    });
    const client = await test.connect();
    // When post-run diffing cannot read Git state.
    client.send(runMessage);
    const failure = await client.outcome();
    expect(failure).toMatchObject({ type: 'error', code: 'diff-unavailable', runId: expect.any(String) });
    if (failure.type !== 'error' || !failure.runId) throw new Error('expected run-scoped failure');
    await client.close();
    const recovered = await test.connect();
    expect(await recovered.next()).toEqual(failure);
    recovered.send(runMessage);
    expect((await recovered.next()).type).toBe('error');
    // Then restoring Git access and retrying diff preserves the original baseline.
    await fs.rename(path.join(test.cwd, '.git-held'), path.join(test.cwd, '.git'));
    recovered.send({ type: 'retry-diff', runId: failure.runId });
    const diff = await recovered.next();
    expect(diff).toMatchObject({ type: 'diff', runId: failure.runId, state: 'pending' });
    recovered.send({ type: 'reject', runId: failure.runId });
    expect((await recovered.next()).type).toBe('restored');
    expect(await fs.readFile(path.join(test.cwd, 'tracked.txt'), 'utf8')).toBe('original\n');
  });

  it('serializes project mutations while accept is capturing undo bytes', async () => {
    // Given real snapshot capture paused at its async boundary.
    await using test = await fixture(writeChange);
    const client = await test.connect();
    const diff = await startRun(client);
    const entered = signal();
    const release = signal();
    const original = snapshot.buildUndoFiles;
    const capture = vi.spyOn(snapshot, 'buildUndoFiles').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    try {
      // When another request of each mutating kind arrives during accept.
      client.send({ type: 'accept', runId: diff.runId });
      await entered.promise;
      client.send(runMessage);
      client.send({ type: 'undo-run', id: 'any' });
      client.send({ type: 'reject', runId: diff.runId });
      client.send({ type: 'accept', runId: diff.runId });
      // Then every competing request is refused until capture completes.
      for (let i = 0; i < 4; i++) expect((await client.next()).type).toBe('error');
      release.resolve();
      expect(await client.next()).toMatchObject({ type: 'diff', runId: diff.runId, state: 'resolved' });
    } finally {
      release.resolve();
      capture.mockRestore();
    }
  });
});
