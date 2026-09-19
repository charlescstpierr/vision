import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunHistory } from './history.js';
import type { UndoFile } from './snapshot.js';

let root: string;
const PROJECT = '/home/u/some-project';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vizion-history-test-'));
});

afterEach(async () => {
  await fs.chmod(root, 0o700).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
});

function record(prompt: string, files: string[] = ['a.ts']) {
  return {
    agent: 'claude' as const,
    prompt,
    selectors: ['#btn'],
    createdAt: Date.now(),
    files,
    status: 'applied' as const,
  };
}

function undoFile(p: string, before: string | null, after: string | null): UndoFile {
  return {
    path: p,
    before: before === null ? null : { content: Buffer.from(before), mode: 0o644 },
    after: after === null ? null : { content: Buffer.from(after), mode: 0o644 },
  };
}

describe('RunHistory', () => {
  it('stores runs newest first and hands back the generated id', async () => {
    const history = await RunHistory.open(PROJECT, root);
    const first = await history.add(record('first'), []);
    const second = await history.add(record('second'), []);
    expect(first?.id).toBeTruthy();
    expect(second?.id).not.toBe(first?.id);
    expect(history.list().map((r) => r.prompt)).toEqual(['second', 'first']);
  });

  it('survives a restart: a new instance reads back what the last one wrote', async () => {
    const history = await RunHistory.open(PROJECT, root);
    const stored = await history.add(record('persisted'), [undoFile('a.ts', 'before\n', 'after\n')]);
    if (!stored) throw new Error('expected the run to be stored');

    // A fresh server process, same project.
    const reopened = await RunHistory.open(PROJECT, root);
    expect(reopened.list().map((r) => r.prompt)).toEqual(['persisted']);

    const entry = await reopened.get(stored.id);
    expect(entry?.files[0]?.before?.content.toString()).toBe('before\n');
    expect(entry?.files[0]?.after?.content.toString()).toBe('after\n');
  });

  it('restores byte-exact content, including binary and a null side', async () => {
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x7f]);
    const history = await RunHistory.open(PROJECT, root);
    const stored = await history.add(record('bin', ['i.bin', 'new.ts']), [
      { path: 'i.bin', before: { content: binary, mode: 0o644 }, after: null },
      undoFile('new.ts', null, 'created\n'),
    ]);
    if (!stored) throw new Error('expected the run to be stored');

    const entry = await (await RunHistory.open(PROJECT, root)).get(stored.id);
    expect(entry?.files[0]?.before?.content).toEqual(binary);
    expect(entry?.files[0]?.after).toBeNull();
    expect(entry?.files[1]?.before).toBeNull();
    expect(entry?.files[1]?.after?.content.toString()).toBe('created\n');
  });

  it('keeps the file mode alongside the content', async () => {
    const history = await RunHistory.open(PROJECT, root);
    const stored = await history.add(record('mode'), [
      { path: 's.sh', before: { content: Buffer.from('#!/bin/sh\n'), mode: 0o755 }, after: null },
    ]);
    if (!stored) throw new Error('expected the run to be stored');
    const entry = await (await RunHistory.open(PROJECT, root)).get(stored.id);
    expect(entry?.files[0]?.before?.mode).toBe(0o755);
  });

  it('carries headSha so an undo can reset a commit the agent made mid-run', async () => {
    const history = await RunHistory.open(PROJECT, root);
    const stored = await history.add(record('commits'), [], 'abc123');
    if (!stored) throw new Error('expected the run to be stored');
    expect((await (await RunHistory.open(PROJECT, root)).get(stored.id))?.headSha).toBe('abc123');
  });

  it('persists markUndone, so a restart does not offer to undo it twice', async () => {
    const history = await RunHistory.open(PROJECT, root);
    const stored = await history.add(record('undone'), [undoFile('a.ts', 'x\n', 'y\n')]);
    if (!stored) throw new Error('expected the run to be stored');

    expect(await history.markUndone(stored.id)).toBe(true);
    expect(history.list()[0]?.status).toBe('undone');
    expect((await RunHistory.open(PROJECT, root)).list()[0]?.status).toBe('undone');
  });

  it('markUndone reports an unknown id instead of throwing', async () => {
    const history = await RunHistory.open(PROJECT, root);
    expect(await history.markUndone('nope')).toBe(false);
    expect(await history.get('nope')).toBeUndefined();
  });

  it('keeps projects apart, so one project never offers to undo another\'s run', async () => {
    const a = await RunHistory.open('/home/u/project-a', root);
    await a.add(record('from a'), []);
    const b = await RunHistory.open('/home/u/project-b', root);
    expect(b.list()).toEqual([]);
    expect((await RunHistory.open('/home/u/project-a', root)).list()).toHaveLength(1);
  });

  it('caps the history at 50 runs and deletes the dropped ones from disk', async () => {
    const history = await RunHistory.open(PROJECT, root);
    for (let i = 0; i < 52; i++) {
      await history.add(record(`run ${i}`), [undoFile('a.ts', `${i}\n`, `${i + 1}\n`)]);
    }
    expect(history.list()).toHaveLength(50);
    expect(history.list()[0]?.prompt).toBe('run 51');
    expect(history.list()[49]?.prompt).toBe('run 2');

    // The blobs of the dropped runs are gone, not just forgotten.
    const dirs = await fs.readdir(path.join(root, (await fs.readdir(root))[0]!));
    expect(dirs).toHaveLength(50);
  });

  it('skips a run directory it cannot parse rather than failing to open', async () => {
    const history = await RunHistory.open(PROJECT, root);
    const stored = await history.add(record('good'), []);
    if (!stored) throw new Error('expected the run to be stored');

    const projectRoot = path.join(root, (await fs.readdir(root))[0]!);
    await fs.mkdir(path.join(projectRoot, 'corrupt'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'corrupt', 'run.json'), '{ not json');
    await fs.mkdir(path.join(projectRoot, 'empty'), { recursive: true });

    const reopened = await RunHistory.open(PROJECT, root);
    expect(reopened.list().map((r) => r.prompt)).toEqual(['good']);
  });

  it('reports a run it could not store, instead of pretending it is undoable', async () => {
    // A regular file where the history root should be: every mkdir under it
    // fails with ENOTDIR, which stands in for a full or read-only disk (and
    // unlike chmod, it also holds when the tests run as root).
    const blocked = path.join(root, 'not-a-directory');
    await fs.writeFile(blocked, 'x');

    const history = await RunHistory.open(PROJECT, blocked);
    expect(history.list()).toEqual([]);
    expect(await history.add(record('unwritable'), [undoFile('a.ts', 'x\n', 'y\n')])).toBeNull();
    expect(history.list()).toEqual([]);
  });
});
