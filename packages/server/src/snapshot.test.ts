import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeDiff, restoreSnapshot, takeSnapshot } from './snapshot.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vizion-snapshot-test-'));
  await git(dir, ['init', '-q']);
  await git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-q', '-m', 'init']);
  return dir;
}

describe('snapshot', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await initRepo();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('diffs a modified tracked file and a new file added by the agent', async () => {
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'line1\nline2\n');
    await git(dir, ['add', 'tracked.txt']);
    await git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'add tracked']);

    const snapshot = await takeSnapshot(dir);
    expect(snapshot.isGit).toBe(true);

    // Simulate the agent run.
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'line1\nCHANGED\n');
    await fs.writeFile(path.join(dir, 'new.txt'), 'brand new\n');

    const diffs = await computeDiff(dir, snapshot);
    const byPath = new Map(diffs.map((d) => [d.path, d]));

    const modified = byPath.get('tracked.txt');
    expect(modified?.status).toBe('modified');
    expect(modified?.patch).toContain('--- a/tracked.txt');
    expect(modified?.patch).toContain('+++ b/tracked.txt');
    expect(modified?.patch).toContain('+CHANGED');

    const added = byPath.get('new.txt');
    expect(added?.status).toBe('added');
    expect(added?.patch).toContain('--- a/new.txt');
    expect(added?.patch).toContain('+++ b/new.txt');
    expect(added?.patch).toContain('+brand new');
  });

  it('diffs against pre-existing dirty content, not HEAD, and restores it on reject', async () => {
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'original\n');
    await git(dir, ['add', 'tracked.txt']);
    await git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'add tracked']);

    // The user already has uncommitted changes before the agent runs.
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'user-edit\n');

    const snapshot = await takeSnapshot(dir);

    // The agent further modifies the file.
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'agent-edit\n');

    const diffs = await computeDiff(dir, snapshot);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.status).toBe('modified');
    expect(diffs[0]?.patch).not.toContain('original');
    expect(diffs[0]?.patch).toContain('-user-edit');
    expect(diffs[0]?.patch).toContain('+agent-edit');

    const restored = await restoreSnapshot(dir, snapshot, diffs.map((d) => d.path));
    expect(restored).toEqual(['tracked.txt']);
    const content = await fs.readFile(path.join(dir, 'tracked.txt'), 'utf8');
    expect(content).toBe('user-edit\n');
  });

  it('handles a deleted tracked file and restores it on reject', async () => {
    await fs.writeFile(path.join(dir, 'gone.txt'), 'keep me\n');
    await git(dir, ['add', 'gone.txt']);
    await git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'add gone']);

    const snapshot = await takeSnapshot(dir);
    await fs.unlink(path.join(dir, 'gone.txt'));

    const diffs = await computeDiff(dir, snapshot);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.status).toBe('deleted');

    const restored = await restoreSnapshot(dir, snapshot, diffs.map((d) => d.path));
    expect(restored).toEqual(['gone.txt']);
    const content = await fs.readFile(path.join(dir, 'gone.txt'), 'utf8');
    expect(content).toBe('keep me\n');
  });

  it('handles a new file added by the agent and deletes it on reject', async () => {
    const snapshot = await takeSnapshot(dir);
    await fs.writeFile(path.join(dir, 'added.txt'), 'new content\n');

    const diffs = await computeDiff(dir, snapshot);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.status).toBe('added');

    const restored = await restoreSnapshot(dir, snapshot, diffs.map((d) => d.path));
    expect(restored).toEqual(['added.txt']);
    await expect(fs.readFile(path.join(dir, 'added.txt'))).rejects.toThrow();
  });

  it('is a no-op outside a git repository', async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vizion-nongit-test-'));
    try {
      const snapshot = await takeSnapshot(nonGitDir);
      expect(snapshot.isGit).toBe(false);
      await fs.writeFile(path.join(nonGitDir, 'x.txt'), 'hi\n');
      expect(await computeDiff(nonGitDir, snapshot)).toEqual([]);
      expect(await restoreSnapshot(nonGitDir, snapshot, ['x.txt'])).toEqual([]);
    } finally {
      await fs.rm(nonGitDir, { recursive: true, force: true });
    }
  });
});
