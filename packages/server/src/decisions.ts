import crypto from 'node:crypto';
import type { ClientMessage, FileDiff, ServerMessage } from '@vizion/shared';
import type { RunHistory } from './history.js';
import { buildUndoFiles, computeDiff, restoreSnapshot, type Snapshot } from './snapshot.js';

type Run = Extract<ClientMessage, { type: 'run' }>;
type DecisionMessage = Extract<ClientMessage, { type: 'accept' | 'reject' | 'retry-diff' }>;
type RecoveryError = Extract<ServerMessage, { type: 'error' }>;
type Review =
  | { readonly state: 'unavailable'; readonly error: RecoveryError }
  | { readonly state: 'pending' | 'reject-only'; readonly files: FileDiff[] };
type Pending = {
  readonly runId: string;
  readonly snapshot: Snapshot;
  readonly request: Run;
  readonly review: Review;
};

export class DecisionError extends Error {
  readonly name = 'DecisionError';
  constructor(readonly response: RecoveryError) {
    super(response.message);
  }
}

/** Server-owned recovery state. Call mutations only while holding the project operation lock. */
export class Decisions {
  private pending: Pending | null = null;

  constructor(
    private readonly history: RunHistory,
    private readonly broadcast: (message: ServerMessage) => void,
  ) {}

  get exists(): boolean {
    return this.pending !== null;
  }

  current(): ServerMessage | null {
    const pending = this.pending;
    if (!pending) return null;
    switch (pending.review.state) {
      case 'unavailable': return pending.review.error;
      case 'pending':
      case 'reject-only':
        return { type: 'diff', runId: pending.runId, state: pending.review.state, files: pending.review.files };
      default: return pending.review satisfies never;
    }
  }

  async capture(snapshot: Snapshot, request: Run): Promise<void> {
    const runId = crypto.randomUUID();
    const pending: Pending = {
      runId, snapshot, request,
      review: { state: 'unavailable', error: { type: 'error', code: 'diff-unavailable', runId, message: 'Diff en cours.' } },
    };
    // Retain the baseline BEFORE diffing: failure must never enable another run.
    this.pending = pending;
    await this.refresh(pending);
  }

  private async refresh(pending: Pending): Promise<void> {
    try {
      const files = await computeDiff(pending.snapshot);
      this.pending = { ...pending, review: { state: 'pending', files } };
      this.broadcast({ type: 'diff', runId: pending.runId, state: 'pending', files });
    } catch (err) {
      const error: RecoveryError = {
        type: 'error', runId: pending.runId, code: 'diff-unavailable',
        message: err instanceof Error ? err.message : 'Echec du calcul du diff.',
      };
      this.pending = { ...pending, review: { state: 'unavailable', error } };
      this.broadcast(error);
    }
  }

  async resolve(message: DecisionMessage, reply: (message: ServerMessage) => void): Promise<void> {
    const pending = this.pending;
    if (!pending) throw new DecisionError({ type: 'error', message: 'rien à accepter ou rejeter' });
    // Also fences untyped/legacy clients: undefined can never match a server-generated ID.
    if (message.runId !== pending.runId) {
      throw new DecisionError({ type: 'error', message: 'Identifiant de run absent ou périmé.' });
    }
    switch (message.type) {
      case 'retry-diff':
        switch (pending.review.state) {
          case 'unavailable': await this.refresh(pending); return;
          case 'pending':
          case 'reject-only':
            // Reply without replacing the original restore set after partial restoration.
            reply({ type: 'diff', runId: pending.runId, state: pending.review.state, files: pending.review.files });
            return;
          default: return pending.review satisfies never;
        }
      case 'accept':
      case 'reject': break;
      default: return message satisfies never;
    }
    switch (pending.review.state) {
      case 'unavailable': throw new DecisionError(pending.review.error);
      case 'reject-only':
        switch (message.type) {
          case 'accept': throw new DecisionError({ type: 'error', runId: pending.runId, code: 'reject-only', message: 'La restauration doit être terminée avant de continuer.' });
          case 'reject': break;
          default: return message satisfies never;
        }
        break;
      case 'pending': break;
      default: return pending.review satisfies never;
    }
    const files = pending.review.files;
    const paths = files.map((file) => file.path);
    switch (message.type) {
      case 'accept': {
        const undoFiles = await buildUndoFiles(pending.snapshot, paths);
        this.history.add({
          agent: pending.request.agent, prompt: pending.request.prompt,
          selectors: (pending.request.elements ?? [pending.request.element]).map((element) => element.selector),
          createdAt: Date.now(), files: paths, status: 'accepted',
        }, undoFiles);
        break;
      }
      case 'reject': {
        // Set before the first write/reset. A failed restore is irreversible except by retrying it.
        this.pending = { ...pending, review: { state: 'reject-only', files } };
        try {
          const result = await restoreSnapshot(pending.snapshot, paths);
          if (result.skipped.length > 0) {
            throw new DecisionError({ type: 'error', runId: pending.runId, code: 'reject-only', paths: result.skipped, message: `Fichiers non restaurés : ${result.skipped.join(', ')}` });
          }
          reply({ type: 'restored', files: result.restored });
        } catch (err) {
          if (err instanceof DecisionError) throw err;
          throw new DecisionError({ type: 'error', runId: pending.runId, code: 'reject-only', message: err instanceof Error ? err.message : 'Echec de la restauration.' });
        }
        break;
      }
      default: return message satisfies never;
    }
    this.pending = null;
    this.broadcast({ type: 'diff', runId: pending.runId, state: 'resolved', files: [] });
    this.broadcast({ type: 'history', runs: this.history.list() });
  }
}
