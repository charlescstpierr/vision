import crypto from 'node:crypto';
import type { RunRecord } from '@vizion/shared';
import type { UndoFile } from './snapshot.js';

/** Hard cap on how many accepted runs are kept in memory. */
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

/**
 * In-memory history of accepted agent runs, newest first, capped at
 * `MAX_HISTORY` entries. Pure and side-effect free (no filesystem or git
 * access) so it can be unit tested directly; the actual restore for
 * `undo-run` lives in server.ts, which uses `get`/`markUndone` on the entry
 * this class hands back.
 */
export class RunHistory {
  private entries: HistoryEntry[] = [];

  /** Stores a new record, generating its `id`. Returns the stored record. */
  add(record: Omit<RunRecord, 'id'>, files: UndoFile[], headSha: string | null = null): RunRecord {
    const full: RunRecord = { ...record, id: crypto.randomUUID() };
    this.entries.unshift({ record: full, files, headSha });
    if (this.entries.length > MAX_HISTORY) {
      this.entries.length = MAX_HISTORY;
    }
    return full;
  }

  /** Newest first. */
  list(): RunRecord[] {
    return this.entries.map((entry) => entry.record);
  }

  get(id: string): HistoryEntry | undefined {
    return this.entries.find((entry) => entry.record.id === id);
  }

  /** Marks a stored record as undone. Returns whether `id` was found. */
  markUndone(id: string): boolean {
    const entry = this.get(id);
    if (!entry) return false;
    entry.record.status = 'undone';
    return true;
  }
}
