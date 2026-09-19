import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeDiff, takeSnapshot } from './snapshot.js';

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
  });

  it.skipIf(IS_WIN32)('detects a mode-only change', async () => {
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
  });
});
