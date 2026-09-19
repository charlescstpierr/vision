import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RunRecord } from '@vizion/shared';
import type { UndoFile, UndoFileSide } from './snapshot.js';

/** Hard cap on how many runs are kept. Older ones are deleted from disk. */
const MAX_HISTORY = 50;

export interface HistoryEntry {
  record: RunRecord;
  /** Byte-exact before/after state of each touched path, so `undo-run` can restore it. */
  files: UndoFile[];
  /**
   * `HEAD` as it stood just before the run. An agent may commit while it
   * works, and restoring file contents alone would leave those commits on the
   * branch; undo resets back to this first. Null outside a git repo.
   */
  headSha: string | null;
}

/** What `run.json` holds: everything but the file contents, which sit beside it as raw blobs. */
interface StoredRun {
  record: RunRecord;
  headSha: string | null;
  files: { path: string; before: { mode: number } | null; after: { mode: number } | null }[];
}

/** The per-project directory under `root`, named by a digest so a path can never escape it. */
function projectDir(root: string, projectPath: string): string {
  const key = crypto.createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
  return path.join(root, key);
}

function defaultRoot(): string {
  return path.join(os.homedir(), '.vizion', 'history');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Narrows a `run.json` read back off disk. Everything there was written by a
 * previous version of this server, so a shape that no longer matches is
 * dropped rather than trusted.
 */
function parseStoredRun(value: unknown): StoredRun | null {
  if (!isRecord(value)) return null;
  const { record, headSha, files } = value;
  if (!isRecord(record)) return null;
  if (typeof record.id !== 'string' || !record.id) return null;
  if (record.status !== 'applied' && record.status !== 'undone') return null;
  if (typeof record.createdAt !== 'number') return null;
  if (!Array.isArray(record.files) || !Array.isArray(record.selectors)) return null;
  if (headSha !== null && typeof headSha !== 'string') return null;
  if (!Array.isArray(files)) return null;
  for (const file of files) {
    if (!isRecord(file) || typeof file.path !== 'string') return null;
  }
  return value as unknown as StoredRun;
}

/**
 * The runs a project's agent has applied, newest first, kept on disk under
 * `~/.vizion/history/<project digest>/` so they survive a server restart.
 *
 * Only the metadata stays in memory. A run's before/after file contents --
 * which is what `undo-run` actually writes back, and can be megabytes per run
 * -- live beside it as raw blobs and are read only when that run is undone.
 * Keeping 50 runs' worth of buffers resident was the alternative.
 *
 * Nothing here is written into the user's project: that would show up in
 * their own diffs, which is precisely what Vizion is supposed to keep clean.
 */
export class RunHistory {
  private entries: { record: RunRecord; dir: string }[] = [];

  private constructor(private readonly dir: string) {}

  /**
   * Opens (and creates) the history for `projectPath`, loading what a previous
   * run of the server left behind. A directory that cannot be read at all
   * yields an empty history rather than failing the server's start: not being
   * able to undo is worse than nothing, but not starting is worse still.
   */
  static async open(projectPath: string, root: string = defaultRoot()): Promise<RunHistory> {
    const dir = projectDir(root, projectPath);
    const history = new RunHistory(dir);
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const names = await fs.readdir(dir);
      const loaded: { record: RunRecord; dir: string }[] = [];
      for (const name of names) {
        const runDir = path.join(dir, name);
        const stored = await history.readRun(runDir);
        if (stored) loaded.push({ record: stored.record, dir: runDir });
      }
      loaded.sort((a, b) => b.record.createdAt - a.record.createdAt);
      history.entries = loaded;
    } catch {
      history.entries = [];
    }
    return history;
  }

  private async readRun(runDir: string): Promise<StoredRun | null> {
    try {
      const raw = await fs.readFile(path.join(runDir, 'run.json'), 'utf8');
      return parseStoredRun(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * Stores a run and returns the record, or null if it could not be written --
   * the run itself already happened either way, so a failure here means "not
   * undoable", not "failed".
   */
  async add(
    record: Omit<RunRecord, 'id'>,
    files: UndoFile[],
    headSha: string | null = null,
  ): Promise<RunRecord | null> {
    const full: RunRecord = { ...record, id: crypto.randomUUID() };
    const runDir = path.join(this.dir, full.id);
    try {
      await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
      const stored: StoredRun = {
        record: full,
        headSha,
        files: files.map((file) => ({
          path: file.path,
          before: file.before ? { mode: file.before.mode } : null,
          after: file.after ? { mode: file.after.mode } : null,
        })),
      };
      // 0600 like `run.json`: these blobs are verbatim copies of the user's
      // project files, so they deserve the same protection as the metadata.
      await Promise.all(
        files.flatMap((file, index) => [
          ...(file.before
            ? [fs.writeFile(path.join(runDir, `${index}.before`), file.before.content, { mode: 0o600 })]
            : []),
          ...(file.after
            ? [fs.writeFile(path.join(runDir, `${index}.after`), file.after.content, { mode: 0o600 })]
            : []),
        ]),
      );
      // Written last, so it is the commit point: a crash before this leaves a
      // directory with no `run.json`, which `open` skips rather than reading
      // half a run back.
      await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(stored), { mode: 0o600 });
    } catch {
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    this.entries.unshift({ record: full, dir: runDir });
    await this.prune();
    return full;
  }

  /** Drops the oldest runs past `MAX_HISTORY`, deleting their blobs too. */
  private async prune(): Promise<void> {
    const dropped = this.entries.splice(MAX_HISTORY);
    for (const entry of dropped) {
      await fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Newest first. Metadata only, straight from memory. */
  list(): RunRecord[] {
    return this.entries.map((entry) => entry.record);
  }

  /** Loads a run's full before/after contents from disk. Undefined if unknown or unreadable. */
  async get(id: string): Promise<HistoryEntry | undefined> {
    const entry = this.entries.find((candidate) => candidate.record.id === id);
    if (!entry) return undefined;
    const stored = await this.readRun(entry.dir);
    if (!stored) return undefined;

    const side = async (
      index: number,
      which: 'before' | 'after',
      meta: { mode: number } | null,
    ): Promise<UndoFileSide | null> => {
      if (!meta) return null;
      const content = await fs.readFile(path.join(entry.dir, `${index}.${which}`));
      return { content, mode: meta.mode };
    };

    try {
      const files: UndoFile[] = await Promise.all(
        stored.files.map(async (file, index) => ({
          path: file.path,
          before: await side(index, 'before', file.before),
          after: await side(index, 'after', file.after),
        })),
      );
      // `entry.record` is the live object the list hands out; prefer it over
      // the stored copy so an in-memory status change is never read back stale.
      return { record: entry.record, files, headSha: stored.headSha };
    } catch {
      return undefined;
    }
  }

  /** Marks a stored record as undone, on disk as well. Returns whether `id` was found. */
  async markUndone(id: string): Promise<boolean> {
    const entry = this.entries.find((candidate) => candidate.record.id === id);
    if (!entry) return false;
    entry.record.status = 'undone';
    const stored = await this.readRun(entry.dir);
    if (stored) {
      stored.record.status = 'undone';
      await fs
        .writeFile(path.join(entry.dir, 'run.json'), JSON.stringify(stored), { mode: 0o600 })
        .catch(() => {});
    }
    return true;
  }
}
