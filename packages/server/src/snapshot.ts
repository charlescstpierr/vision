import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FileDiff } from '@vizion/shared';

const execFileAsync = promisify(execFile);

const MAX_SNAPSHOT_FILE_SIZE = 5 * 1024 * 1024;
const MAX_BUFFER = 20 * 1024 * 1024;

export interface SnapshotFile {
  path: string;
  existed: boolean;
  content: Buffer | null;
  /** True if the file existed but was skipped (> 5 MB); content is null and cannot be restored precisely. */
  tooLarge?: boolean;
}

export interface Snapshot {
  isGit: boolean;
  cwd: string;
  headSha: string | null;
  files: Map<string, SnapshotFile>;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function getHeadSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Paths reported dirty by `git status --porcelain=v1 -z -uall` (modified,
 * added, untracked, deleted, renamed). For a rename/copy, both the new and
 * the original path are included: `git status -z` separates them with NUL
 * instead of the human-readable `old -> new` arrow.
 */
async function getDirtyPaths(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain=v1', '-z', '-uall'],
    { cwd, maxBuffer: MAX_BUFFER },
  );
  const parts = stdout.split('\0');
  const paths: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    if (entry === undefined || entry.length === 0) {
      i++;
      continue;
    }
    const statusCode = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (statusCode[0] === 'R' || statusCode[0] === 'C') {
      i++;
      const orig = parts[i];
      if (orig !== undefined && orig.length > 0) {
        paths.push(orig);
      }
    }
    i++;
  }
  return paths;
}

async function readCurrentContent(cwd: string, relPath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(cwd, relPath));
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

async function getHeadBlob(cwd: string, relPath: string): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync('git', ['show', `HEAD:${relPath}`], {
      cwd,
      encoding: 'buffer',
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Snapshots the current dirty state of the working tree before an agent
 * run, so `computeDiff`/`restoreSnapshot` can later tell the agent's
 * changes apart from the user's own pre-existing uncommitted edits.
 */
export async function takeSnapshot(cwd: string): Promise<Snapshot> {
  const gitRepo = await isGitRepo(cwd);
  if (!gitRepo) {
    return { isGit: false, cwd, headSha: null, files: new Map() };
  }
  const headSha = await getHeadSha(cwd);
  const dirtyPaths = await getDirtyPaths(cwd);
  const files = new Map<string, SnapshotFile>();
  for (const relPath of dirtyPaths) {
    const abs = path.join(cwd, relPath);
    try {
      const stat = await fs.stat(abs);
      if (stat.size > MAX_SNAPSHOT_FILE_SIZE) {
        files.set(relPath, { path: relPath, existed: true, content: null, tooLarge: true });
      } else {
        files.set(relPath, { path: relPath, existed: true, content: await fs.readFile(abs) });
      }
    } catch (err) {
      if (isEnoent(err)) {
        files.set(relPath, { path: relPath, existed: false, content: null });
      } else {
        throw err;
      }
    }
  }
  return { isGit: true, cwd, headSha, files };
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

async function resolveBeforeContent(
  cwd: string,
  snapshot: Snapshot,
  relPath: string,
): Promise<Buffer | null> {
  const snap = snapshot.files.get(relPath);
  if (snap) {
    if (!snap.existed) return null;
    // Too-large files were not captured; best effort is an empty "before"
    // so a diff can still be produced (the patch just won't be precise).
    return snap.content ?? Buffer.alloc(0);
  }
  return getHeadBlob(cwd, relPath);
}

/** Rewrites the `a/before` / `b/after` temp-file headers to the real repo-relative path. */
function rewriteHeaders(patch: string, relPath: string): string {
  return patch.split('a/before').join(`a/${relPath}`).split('b/after').join(`b/${relPath}`);
}

async function diffOnePath(
  tmpRoot: string,
  index: number,
  relPath: string,
  before: Buffer | null,
  after: Buffer | null,
): Promise<string> {
  const dir = path.join(tmpRoot, String(index));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'before'), before ?? Buffer.alloc(0));
  await fs.writeFile(path.join(dir, 'after'), after ?? Buffer.alloc(0));

  try {
    const { stdout } = await execFileAsync('git', ['diff', '--no-index', '--', 'before', 'after'], {
      cwd: dir,
      maxBuffer: MAX_BUFFER,
    });
    return rewriteHeaders(stdout, relPath);
  } catch (err) {
    // `git diff --no-index` exits 1 (not an error for us) when the files differ.
    const execErr = err as { code?: number; stdout?: string };
    if (execErr.code === 1 && typeof execErr.stdout === 'string') {
      return rewriteHeaders(execErr.stdout, relPath);
    }
    throw err;
  }
}

/**
 * Diffs the current working tree against `snapshot`, limited to files that
 * were touched by the agent run (i.e. dirty now, dirty at snapshot time, or
 * both). Outside a git repo, diffing is unavailable and this returns [].
 */
export async function computeDiff(cwd: string, snapshot: Snapshot): Promise<FileDiff[]> {
  if (!snapshot.isGit) return [];

  const currentDirty = await getDirtyPaths(cwd);
  const candidates = new Set<string>([...currentDirty, ...snapshot.files.keys()]);

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vizion-diff-'));
  try {
    const results: FileDiff[] = [];
    let index = 0;
    for (const relPath of candidates) {
      index++;
      const [before, after] = await Promise.all([
        resolveBeforeContent(cwd, snapshot, relPath),
        readCurrentContent(cwd, relPath),
      ]);
      if (buffersEqual(before, after)) continue;

      const status: FileDiff['status'] =
        before === null ? 'added' : after === null ? 'deleted' : 'modified';
      const patch = await diffOnePath(tmpRoot, index, relPath, before, after);
      results.push({ path: relPath, status, patch });
    }
    return results;
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function deleteIgnoreEnoent(abs: string): Promise<void> {
  try {
    await fs.unlink(abs);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

/**
 * Restores `paths` to their pre-run state recorded in `snapshot`:
 * - path was already dirty pre-run → write back its saved content (or
 *   delete it if it did not exist / had been deleted before the run);
 * - otherwise, clean at snapshot time → `git checkout HEAD -- path` if it
 *   exists at HEAD, else delete it (it was newly created by the agent).
 * Outside a git repo, reject is unavailable and this returns [].
 */
export async function restoreSnapshot(
  cwd: string,
  snapshot: Snapshot,
  paths: string[],
): Promise<string[]> {
  if (!snapshot.isGit) return [];

  const restored: string[] = [];
  for (const relPath of paths) {
    const abs = path.join(cwd, relPath);
    const snap = snapshot.files.get(relPath);
    if (snap) {
      if (snap.existed) {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, snap.content ?? Buffer.alloc(0));
      } else {
        await deleteIgnoreEnoent(abs);
      }
    } else {
      const headContent = await getHeadBlob(cwd, relPath);
      if (headContent !== null) {
        await execFileAsync('git', ['checkout', 'HEAD', '--', relPath], { cwd });
      } else {
        await deleteIgnoreEnoent(abs);
      }
    }
    restored.push(relPath);
  }
  return restored;
}
