import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ServerMessage } from '@vizion/shared';
import type { RunHistory } from './history.js';

const execFileAsync = promisify(execFile);

async function readFileIfExists(abs: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(abs);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export type UndoContext = {
  readonly cwd: string;
  readonly history: RunHistory;
  readonly broadcast: (message: ServerMessage) => void;
};

/** Caller holds the project reservation throughout conflict checking and restoration. */
export async function undoRun(context: UndoContext, id: string, send: (message: ServerMessage) => void): Promise<void> {
  const { cwd, history, broadcast } = context;
  const entry = history.get(id);
  if (!entry) {
    send({ type: 'error', message: 'Run introuvable.' });
    return;
  }
  if (entry.record.status === 'undone') {
    send({ type: 'error', message: 'Ce run a déjà été annulé.' });
    return;
  }
  const mostRecentAccepted = history.list().find((run) => run.status === 'accepted');
  if (mostRecentAccepted?.id !== id) {
    send({ type: 'error', message: "Annule d'abord les runs plus récents." });
    return;
  }
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    const root = stdout.trim();
    for (const file of entry.files) {
      const current = await readFileIfExists(path.join(root, file.path));
      const matches = file.after === null ? current === null : current !== null && current.equals(file.after.content);
      if (!matches) {
        send({ type: 'error', message: `Conflit : ${file.path} a été modifié depuis ce run. Annulation impossible.` });
        return;
      }
    }
    for (const file of entry.files) {
      const abs = path.join(root, file.path);
      if (file.before === null) await fs.rm(abs, { force: true });
      else {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, file.before.content);
        if (process.platform !== 'win32') await fs.chmod(abs, file.before.mode);
      }
    }
    history.markUndone(id);
    send({ type: 'run-undone', id, files: entry.record.files });
    broadcast({ type: 'history', runs: history.list() });
  } catch (err) {
    const stderr = err instanceof Error && 'stderr' in err && typeof err.stderr === 'string' ? err.stderr : '';
    const firstLine = stderr.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
    send({ type: 'error', message: `Échec de l'annulation du run : ${firstLine ?? (err instanceof Error ? err.message : 'erreur inconnue')}` });
  }
}
