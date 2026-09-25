import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FileDiff } from '@vizion/shared';

const execFileAsync = promisify(execFile);

const MAX_SNAPSHOT_FILE_SIZE = 5 * 1024 * 1024;
const MAX_BUFFER = 20 * 1024 * 1024;
const IS_WIN32 = process.platform === 'win32';

export interface SnapshotFile {
  path: string;
  existed: boolean;
  content: Buffer | null;
  /** `fs.stat().mode & 0o777` at snapshot time; null if the file did not exist, or on win32. */
  mode: number | null;
  /** True if the file existed but was skipped (> the size limit); content is null and cannot be restored precisely. */
  tooLarge?: boolean;
}

export interface Snapshot {
  isGit: boolean;
  /** The directory the server was started in; kept for reference. */
  cwd: string;
  /** `git rev-parse --show-toplevel` resolved once at snapshot time. All git
   *  operations and path joins use this, not `cwd`, because `git status`
   *  reports paths relative to the repo root, not to the current directory. */
  root: string;
  headSha: string | null;
  files: Map<string, SnapshotFile>;
}

export interface TakeSnapshotOptions {
  /** Overrides the size limit (bytes) above which a dirty file is marked `tooLarge`. */
  maxFileBytes?: number;
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

async function getRepoRoot(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
  return stdout.trim();
}

async function getHeadSha(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Paths reported dirty by `git status --porcelain=v1 -z -uall`, relative to
 * the repo root (modified, added, untracked, deleted, renamed). For a
 * rename/copy, both the new and the original path are included: `git status
 * -z` separates them with NUL instead of the human-readable `old -> new`
 * arrow.
 */
async function getDirtyPaths(root: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain=v1', '-z', '-uall'],
    { cwd: root, maxBuffer: MAX_BUFFER },
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

async function readCurrentContent(root: string, relPath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(root, relPath));
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

async function getCurrentMode(root: string, relPath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(path.join(root, relPath));
    return stat.mode & 0o777;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** Reads `path` as it was at `sha` (the pre-run HEAD), or null if it did not exist there. */
async function getBlobAt(root: string, sha: string | null, relPath: string): Promise<Buffer | null> {
  if (!sha) return null;
  // Only an absent tree entry means "did not exist". Git/I/O failures must
  // propagate, or reject/undo could delete a file whose baseline was unreadable.
  const { stdout: entry } = await execFileAsync(
    'git', ['--literal-pathspecs', 'ls-tree', '-z', sha, '--', relPath], { cwd: root },
  );
  if (!entry) return null;
  const { stdout } = await execFileAsync('git', ['show', `${sha}:${relPath}`], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

/** The regular-file mode (0o644/0o755) for `path` at `sha`, or null if untracked there. */
async function getTreeMode(root: string, sha: string | null, relPath: string): Promise<number | null> {
  if (!sha) return null;
  try {
    const { stdout } = await execFileAsync('git', ['ls-tree', sha, '--', relPath], { cwd: root });
    const line = stdout.split('\n').find((l) => l.trim().length > 0);
    if (!line) return null;
    const modeStr = line.trim().split(/\s+/)[0];
    if (modeStr === '100755') return 0o755;
    if (modeStr === '100644') return 0o644;
    return null;
  } catch {
    return null;
  }
}

/**
 * Snapshots the current dirty state of the working tree before an agent
 * run, so `computeDiff`/`restoreSnapshot` can later tell the agent's
 * changes apart from the user's own pre-existing uncommitted edits.
 */
export async function takeSnapshot(cwd: string, options: TakeSnapshotOptions = {}): Promise<Snapshot> {
  const gitRepo = await isGitRepo(cwd);
  if (!gitRepo) {
    return { isGit: false, cwd, root: cwd, headSha: null, files: new Map() };
  }
  const root = await getRepoRoot(cwd);
  const maxFileBytes = options.maxFileBytes ?? MAX_SNAPSHOT_FILE_SIZE;
  const headSha = await getHeadSha(root);
  const dirtyPaths = await getDirtyPaths(root);
  const files = new Map<string, SnapshotFile>();
  for (const relPath of dirtyPaths) {
    const abs = path.join(root, relPath);
    try {
      const stat = await fs.stat(abs);
      const mode = IS_WIN32 ? null : stat.mode & 0o777;
      if (stat.size > maxFileBytes) {
        files.set(relPath, { path: relPath, existed: true, content: null, mode, tooLarge: true });
      } else {
        files.set(relPath, { path: relPath, existed: true, content: await fs.readFile(abs), mode });
      }
    } catch (err) {
      if (isEnoent(err)) {
        files.set(relPath, { path: relPath, existed: false, content: null, mode: null });
      } else {
        throw err;
      }
    }
  }
  return { isGit: true, cwd, root, headSha, files };
}

export interface UndoFileSide {
  content: Buffer;
  /** POSIX permission bits; 0 on win32, where modes aren't meaningful. */
  mode: number;
}

/** Byte-exact before/after state of one path touched by a run, as needed to undo it. */
export interface UndoFile {
  path: string;
  /** null if the file did not exist before the run. */
  before: UndoFileSide | null;
  /** null if the file does not exist in the current working tree. */
  after: UndoFileSide | null;
}

/**
 * Resolves what `relPath` looked like right before the run captured by
 * `snapshot`: the snapshot's own content for a file that was already dirty,
 * or the blob and mode recorded at `snapshot.headSha` otherwise. Returns
 * null if the file did not exist before the run, or outside a git repo.
 */
export async function readBefore(snapshot: Snapshot, relPath: string): Promise<UndoFileSide | null> {
  if (!snapshot.isGit) return null;
  const root = snapshot.root;
  const content = await resolveBeforeContent(root, snapshot, relPath);
  if (content === null) return null;
  const mode = IS_WIN32 ? 0 : ((await resolveBeforeMode(root, snapshot, relPath)) ?? 0o644);
  return { content, mode };
}

async function readAfter(root: string, relPath: string): Promise<UndoFileSide | null> {
  const content = await readCurrentContent(root, relPath);
  if (content === null) return null;
  const mode = IS_WIN32 ? 0 : ((await getCurrentMode(root, relPath)) ?? 0o644);
  return { content, mode };
}

/**
 * Builds the byte-exact before/after pairs `undo-run` needs for each path a
 * run touched, from the pre-run `snapshot` and the current working tree
 * (called at `accept` time, so "after" is what the run actually left
 * behind). Paths marked `tooLarge` in the snapshot are skipped, since their
 * pre-run content was never captured; in practice `computeDiff` already
 * excludes them from the paths passed in here.
 */
export async function buildUndoFiles(snapshot: Snapshot, paths: string[]): Promise<UndoFile[]> {
  if (!snapshot.isGit) return [];
  const root = snapshot.root;
  const results: UndoFile[] = [];
  for (const relPath of paths) {
    if (snapshot.files.get(relPath)?.tooLarge) continue;
    const [before, after] = await Promise.all([readBefore(snapshot, relPath), readAfter(root, relPath)]);
    results.push({ path: relPath, before, after });
  }
  return results;
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

async function resolveBeforeContent(
  root: string,
  snapshot: Snapshot,
  relPath: string,
): Promise<Buffer | null> {
  const snap = snapshot.files.get(relPath);
  if (snap) {
    if (!snap.existed) return null;
    // Too-large files were not captured; best effort is an empty "before"
    // so a diff can still be produced (the patch just won't be precise).
    // (Excluded from computeDiff's candidate set in practice; kept here as
    // a safe fallback.)
    return snap.content ?? Buffer.alloc(0);
  }
  return getBlobAt(root, snapshot.headSha, relPath);
}

async function resolveBeforeMode(
  root: string,
  snapshot: Snapshot,
  relPath: string,
): Promise<number | null> {
  const snap = snapshot.files.get(relPath);
  if (snap) return snap.existed ? snap.mode : null;
  return getTreeMode(root, snapshot.headSha, relPath);
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

function gitModeString(mode: number): string {
  return `100${mode.toString(8).padStart(3, '0')}`;
}

function modeChangePatch(beforeMode: number, afterMode: number): string {
  return `old mode ${gitModeString(beforeMode)}\nnew mode ${gitModeString(afterMode)}\n`;
}

/**
 * Diffs the current working tree against `snapshot`, limited to files that
 * were touched by the agent run: dirty now, dirty at snapshot time, or
 * changed by a commit the agent made during the run (if HEAD moved past
 * `snapshot.headSha`). Outside a git repo, diffing is unavailable and this
 * returns []. Files marked `tooLarge` in the snapshot are never diffed
 * (their content was not captured, so an empty-buffer diff would be
 * misleading).
 */
export async function computeDiff(snapshot: Snapshot): Promise<FileDiff[]> {
  if (!snapshot.isGit) return [];
  const root = snapshot.root;

  const currentDirty = await getDirtyPaths(root);
  const candidates = new Set<string>(currentDirty);
  for (const [relPath, snap] of snapshot.files) {
    if (!snap.tooLarge) candidates.add(relPath);
  }

  // The agent may have committed during the run; include the paths that
  // differ between the pre-run HEAD and the current HEAD so committed
  // changes still show up.
  if (snapshot.headSha) {
    const currentHeadSha = await getHeadSha(root);
    if (currentHeadSha && currentHeadSha !== snapshot.headSha) {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--name-only', snapshot.headSha, currentHeadSha],
        { cwd: root, maxBuffer: MAX_BUFFER },
      );
      for (const line of stdout.split('\n')) {
        const relPath = line.trim();
        if (relPath) candidates.add(relPath);
      }
    }
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vizion-diff-'));
  try {
    const results: FileDiff[] = [];
    let index = 0;
    for (const relPath of candidates) {
      const snap = snapshot.files.get(relPath);
      if (snap?.tooLarge) continue;

      index++;
      const [before, after] = await Promise.all([
        resolveBeforeContent(root, snapshot, relPath),
        readCurrentContent(root, relPath),
      ]);
      if (buffersEqual(before, after)) {
        // Same bytes; still check for a mode-only change (e.g. `chmod +x`).
        if (!IS_WIN32 && after !== null) {
          const [beforeMode, afterMode] = await Promise.all([
            resolveBeforeMode(root, snapshot, relPath),
            getCurrentMode(root, relPath),
          ]);
          if (beforeMode !== null && afterMode !== null && beforeMode !== afterMode) {
            results.push({
              path: relPath,
              status: 'modified',
              patch: modeChangePatch(beforeMode, afterMode),
            });
          }
        }
        continue;
      }

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

export interface RestoreResult {
  /** Paths successfully restored to their pre-run state. */
  restored: string[];
  /** Paths that could not be restored precisely because they were too large to snapshot. */
  skipped: string[];
}

/**
 * Restores `paths` to their pre-run state recorded in `snapshot`:
 * - if the agent committed during the run (current HEAD moved past
 *   `snapshot.headSha`), first `git reset --mixed` back to it, dropping
 *   those commits from the branch while keeping the working tree;
 * - path was already dirty pre-run → write back its saved content and mode
 *   (or delete it if it did not exist / had been deleted before the run);
 * - otherwise, clean at snapshot time → check out from the pre-run HEAD if
 *   it existed there, else delete it (it was newly created by the agent);
 * - a path marked `tooLarge` in the snapshot is skipped (its content was
 *   never captured, so writing it back would silently truncate it) and
 *   returned in `skipped` instead of `restored`.
 * Outside a git repo, reject is unavailable and this returns empty lists.
 */
export async function restoreSnapshot(snapshot: Snapshot, paths: string[]): Promise<RestoreResult> {
  if (!snapshot.isGit) return { restored: [], skipped: [] };
  const root = snapshot.root;

  if (snapshot.headSha) {
    const currentHeadSha = await getHeadSha(root);
    if (currentHeadSha && currentHeadSha !== snapshot.headSha) {
      await execFileAsync('git', ['reset', '--mixed', snapshot.headSha], { cwd: root });
    }
  }

  const restored: string[] = [];
  const skipped: string[] = [];
  for (const relPath of paths) {
    const snap = snapshot.files.get(relPath);
    if (snap?.tooLarge) {
      skipped.push(relPath);
      continue;
    }

    const abs = path.join(root, relPath);
    if (snap) {
      if (snap.existed) {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, snap.content ?? Buffer.alloc(0));
        if (!IS_WIN32 && snap.mode !== null) await fs.chmod(abs, snap.mode);
      } else {
        await deleteIgnoreEnoent(abs);
      }
    } else {
      const headContent = await getBlobAt(root, snapshot.headSha, relPath);
      if (headContent !== null) {
        // Non-null implies snapshot.headSha is non-null too.
        await execFileAsync('git', ['checkout', snapshot.headSha as string, '--', relPath], { cwd: root });
        if (!IS_WIN32) {
          const mode = await getTreeMode(root, snapshot.headSha, relPath);
          if (mode !== null) await fs.chmod(abs, mode);
        }
      } else {
        await deleteIgnoreEnoent(abs);
      }
    }
    restored.push(relPath);
  }
  return { restored, skipped };
}
