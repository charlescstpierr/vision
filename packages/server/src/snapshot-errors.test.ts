import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { fixture, writeChange } from './recovery-fixture.js';
import { computeDiff, readBefore, takeSnapshot } from './snapshot.js';

const exec = promisify(execFile);

it('reports a diff failure when the original Git blob cannot be read', async () => {
  // Given a captured baseline whose loose Git blob becomes unavailable.
  await using test = await fixture(writeChange);
  const snapshot = await takeSnapshot(test.cwd);
  const { stdout } = await exec('git', ['rev-parse', 'HEAD:tracked.txt'], { cwd: test.cwd });
  const oid = stdout.trim();
  await fs.rm(path.join(test.cwd, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  await writeChange(test.cwd);
  // When the changed file is diffed against its unavailable baseline.
  const result = computeDiff(snapshot);
  // Then Git failure must not be misclassified as an added file with an empty before-side.
  await expect(result).rejects.toThrow();
});

it('refuses undo capture when the baseline tree is unavailable', async () => {
  // Given a snapshot pointing at an unavailable commit.
  await using test = await fixture(writeChange);
  const baseline = await takeSnapshot(test.cwd);
  // When undo capture reads the before-side.
  const result = readBefore({ ...baseline, headSha: 'f'.repeat(40) }, 'tracked.txt');
  // Then it fails instead of recording the original file as nonexistent.
  await expect(result).rejects.toThrow();
});
