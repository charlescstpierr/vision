import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, runMessage, signal, startRun, writeChange } from './recovery-fixture.js';

describe('server-owned decisions', () => {
  it.each(['accept', 'reject'] as const)('allows %s when an authenticated client reconnects', async (type) => {
    // Given a finished run whose owner disconnected.
    await using test = await fixture(writeChange);
    const owner = await test.connect();
    const diff = await startRun(owner);
    await owner.close();
    const recovered = await test.connect();
    // When the recovered decision is resolved by its ID.
    expect(await recovered.next()).toEqual(diff);
    recovered.send({ type, runId: diff.runId });
    if (type === 'reject') expect((await recovered.next()).type).toBe('restored');
    // Then the decision resolves and the intended bytes remain.
    expect(await recovered.next()).toMatchObject({ type: 'diff', runId: diff.runId, state: 'resolved' });
    expect(await fs.readFile(path.join(test.cwd, 'tracked.txt'), 'utf8')).toBe(type === 'accept' ? 'agent\n' : 'original\n');
    if (type === 'reject') {
      expect((await recovered.next()).type).toBe('history');
      const next = await startRun(recovered);
      expect(next.runId).not.toBe(diff.runId);
    }
  });

  it('retains changes when the owner closes during a source run', async () => {
    // Given an agent paused after writing, with another client connected.
    const written = signal();
    const aborted = signal();
    const release = signal();
    await using test = await fixture(async (cwd, abort) => {
      abort.addEventListener('abort', aborted.resolve, { once: true });
      await writeChange(cwd);
      written.resolve();
      await release.promise;
    });
    const owner = await test.connect();
    const observer = await test.connect();
    owner.send(runMessage);
    await written.promise;
    // When the owner closes before the agent stops.
    await owner.close();
    await aborted.promise;
    release.resolve();
    // Then the project diff is delivered to the remaining client and is rejectable.
    const diff = await observer.next();
    if (diff.type !== 'diff') throw new Error('expected recovered diff');
    observer.send({ type: 'reject', runId: diff.runId });
    expect((await observer.next()).type).toBe('restored');
    expect(await fs.readFile(path.join(test.cwd, 'tracked.txt'), 'utf8')).toBe('original\n');
  });

  it('refuses missing and stale IDs when a different decision is pending', async () => {
    // Given a resolved first run and a second pending run.
    await using test = await fixture(writeChange);
    const client = await test.connect();
    const first = await startRun(client);
    client.send({ type: 'reject', runId: first.runId });
    await client.next(); await client.next(); await client.next();
    const second = await startRun(client);
    // When legacy, duplicate, and stale decisions arrive.
    client.send({ type: 'accept' });
    client.send({ type: 'accept', runId: first.runId });
    client.send({ type: 'reject', runId: first.runId });
    // Then none resolves the current run.
    for (let i = 0; i < 3; i++) expect((await client.next()).type).toBe('error');
    await client.close();
    const recovered = await test.connect();
    expect(await recovered.next()).toEqual(second);
  });

  it('fails closed before invoking the runner when preexisting dirty bytes exceed 5 MiB', async () => {
    // Given an oversized dirty file and an observable runner.
    let invoked = false;
    await using test = await fixture(async (cwd) => { invoked = true; await writeChange(cwd); });
    await fs.writeFile(path.join(test.cwd, 'large.bin'), Buffer.alloc(5 * 1024 * 1024 + 1));
    const client = await test.connect();
    // When source mode is requested.
    client.send(runMessage);
    const result = await client.next();
    // Then the boundary reports the path without a runner event or false diff.
    expect(result).toMatchObject({ type: 'error', code: 'snapshot-too-large', paths: ['large.bin'] });
    expect(invoked).toBe(false);
    client.send({ type: 'ping' });
    expect(await client.next()).toEqual({ type: 'pong' });
  });
});
