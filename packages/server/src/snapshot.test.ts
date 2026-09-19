import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeDiff, restoreSnapshot, takeSnapshot } from './snapshot.js';

const execFileAsync = promisify(execFile);
const IS_WIN32 = process.platform === 'win32';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ['add', '-A']);
  await git(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message]);
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
    await commitAll(dir, 'add tracked');

    const snapshot = await takeSnapshot(dir);
    expect(snapshot.isGit).toBe(true);

    // Simulate the agent run.
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'line1\nCHANGED\n');
    await fs.writeFile(path.join(dir, 'new.txt'), 'brand new\n');

    const diffs = await computeDiff(snapshot);
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
    await commitAll(dir, 'add tracked');

    // The user already has uncommitted changes before the agent runs.
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'user-edit\n');

    const snapshot = await takeSnapshot(dir);

    // The agent further modifies the file.
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'agent-edit\n');

    const diffs = await computeDiff(snapshot);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.status).toBe('modified');
    expect(diffs[0]?.patch).not.toContain('original');
    expect(diffs[0]?.patch).toContain('-user-edit');
    expect(diffs[0]?.patch).toContain('+agent-edit');

    const { restored, skipped } = await restoreSnapshot(snapshot, diffs.map((d) => d.path));
    expect(restored).toEqual(['tracked.txt']);
    expect(skipped).toEqual([]);
    const content = await fs.readFile(path.join(dir, 'tracked.txt'), 'utf8');
    expect(content).toBe('user-edit\n');
  });

  it('handles a deleted tracked file and restores it on reject', async () => {
    await fs.writeFile(path.join(dir, 'gone.txt'), 'keep me\n');
    await git(dir, ['add', 'gone.txt']);
    await commitAll(dir, 'add gone');

    const snapshot = await takeSnapshot(dir);
    await fs.unlink(path.join(dir, 'gone.txt'));

    const diffs = await computeDiff(snapshot);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.status).toBe('deleted');

    const { restored } = await restoreSnapshot(snapshot, diffs.map((d) => d.path));
    expect(restored).toEqual(['gone.txt']);
    const content = await fs.readFile(path.join(dir, 'gone.txt'), 'utf8');
    expect(content).toBe('keep me\n');
  });

  it('handles a new file added by the agent and deletes it on reject', async () => {
    const snapshot = await takeSnapshot(dir);
    await fs.writeFile(path.join(dir, 'added.txt'), 'new content\n');

    const diffs = await computeDiff(snapshot);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.status).toBe('added');

    const { restored } = await restoreSnapshot(snapshot, diffs.map((d) => d.path));
    expect(restored).toEqual(['added.txt']);
    await expect(fs.readFile(path.join(dir, 'added.txt'))).rejects.toThrow();
  });

  it('is a no-op outside a git repository', async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vizion-nongit-test-'));
    try {
      const snapshot = await takeSnapshot(nonGitDir);
      expect(snapshot.isGit).toBe(false);
      await fs.writeFile(path.join(nonGitDir, 'x.txt'), 'hi\n');
      expect(await computeDiff(snapshot)).toEqual([]);
      expect(await restoreSnapshot(snapshot, ['x.txt'])).toEqual({ restored: [], skipped: [] });
    } finally {
      await fs.rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it('resolves paths relative to the repo root, not to a subdirectory cwd', async () => {
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(dir, 'sub', 'a.txt'), 'line1\n');
    await git(dir, ['add', 'sub/a.txt']);
    await commitAll(dir, 'add sub/a.txt');

    const subCwd = path.join(dir, 'sub');
    const snapshot = await takeSnapshot(subCwd);
    expect(snapshot.root).toBe(await git(dir, ['rev-parse', '--show-toplevel']).then((s) => s.trim()));

    // Agent (running with cwd = <repo>/sub) modifies the file.
    await fs.writeFile(path.join(dir, 'sub', 'a.txt'), 'line1\nCHANGED\n');

    const diffs = await computeDiff(snapshot);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ path: 'sub/a.txt', status: 'modified' });

    const { restored } = await restoreSnapshot(snapshot, diffs.map((d) => d.path));
    expect(restored).toEqual(['sub/a.txt']);
    const content = await fs.readFile(path.join(dir, 'sub', 'a.txt'), 'utf8');
    expect(content).toBe('line1\n');
  });

  it('excludes large dirty files from the diff and skips restoring them instead of truncating', async () => {
    const bigPath = path.join(dir, 'big.txt');
    await fs.writeFile(bigPath, 'x'.repeat(100));

    const snapshot = await takeSnapshot(dir, { maxFileBytes: 10 });
    const snapFile = snapshot.files.get('big.txt');
    expect(snapFile?.tooLarge).toBe(true);
    expect(snapFile?.content).toBeNull();

    // The agent further changes the large file; it must not appear in the diff.
    await fs.writeFile(bigPath, 'y'.repeat(100));
    const diffs = await computeDiff(snapshot);
    expect(diffs.find((d) => d.path === 'big.txt')).toBeUndefined();

    // Even if asked to restore it directly, it must be skipped, not truncated.
    const { restored, skipped } = await restoreSnapshot(snapshot, ['big.txt']);
    expect(restored).toEqual([]);
    expect(skipped).toEqual(['big.txt']);
    const content = await fs.readFile(bigPath, 'utf8');
    expect(content).toBe('y'.repeat(100));
  });

  it('diffs and reverts a commit made by the agent during the run', async () => {
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'original\n');
    await git(dir, ['add', 'tracked.txt']);
    await commitAll(dir, 'add tracked');

    const snapshot = await takeSnapshot(dir);
    expect(snapshot.headSha).not.toBeNull();

    // Simulate the agent editing the file and committing it.
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'agent-edit\n');
    await commitAll(dir, 'agent commit');

    const diffs = await computeDiff(snapshot);
    const modified = diffs.find((d) => d.path === 'tracked.txt');
    expect(modified?.status).toBe('modified');
    expect(modified?.patch).toContain('-original');
    expect(modified?.patch).toContain('+agent-edit');

    const { restored } = await restoreSnapshot(snapshot, diffs.map((d) => d.path));
    expect(restored).toContain('tracked.txt');

    const headAfter = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    expect(headAfter).toBe(snapshot.headSha);
    const content = await fs.readFile(path.join(dir, 'tracked.txt'), 'utf8');
    expect(content).toBe('original\n');
  });

  it.skipIf(IS_WIN32)('detects a mode-only change and restores the original mode on reject', async () => {
    const filePath = path.join(dir, 'script.sh');
    await fs.writeFile(filePath, '#!/bin/sh\necho hi\n');
    await fs.chmod(filePath, 0o644);
    await git(dir, ['add', 'script.sh']);
    await commitAll(dir, 'add script');

    const snapshot = await takeSnapshot(dir);

    await fs.chmod(filePath, 0o755);

    const diffs = await computeDiff(snapshot);
    const modeDiff = diffs.find((d) => d.path === 'script.sh');
    expect(modeDiff?.status).toBe('modified');
    expect(modeDiff?.patch).toContain('old mode 100644');
    expect(modeDiff?.patch).toContain('new mode 100755');

    const { restored } = await restoreSnapshot(snapshot, diffs.map((d) => d.path));
    expect(restored).toContain('script.sh');
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o644);
  });
});
