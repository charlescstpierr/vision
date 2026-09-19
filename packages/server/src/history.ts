import crypto from 'node:crypto';
import type { FileDiff, RunRecord } from '@vizion/shared';

/** Hard cap on how many accepted runs are kept in memory. */
const MAX_HISTORY = 50;

export interface HistoryEntry {
  record: RunRecord;
  /** The diff produced by the run, kept so `undo-run` can reverse-apply it. */
  patches: FileDiff[];
}

/**
 * In-memory history of accepted agent runs, newest first, capped at
 * `MAX_HISTORY` entries. Pure and side-effect free (no filesystem or git
 * access) so it can be unit tested directly; the actual reverse-apply for
 * `undo-run` lives in server.ts, which uses `get`/`markUndone` on the entry
 * this class hands back.
 */
export class RunHistory {
  private entries: HistoryEntry[] = [];

  /** Stores a new record, generating its `id`. Returns the stored record. */
  add(record: Omit<RunRecord, 'id'>, patches: FileDiff[]): RunRecord {
    const full: RunRecord = { ...record, id: crypto.randomUUID() };
    this.entries.unshift({ record: full, patches });
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
