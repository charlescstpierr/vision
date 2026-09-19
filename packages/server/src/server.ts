import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentKind, AgentRunner, ClientMessage, FileDiff, ServerMessage } from '@vizion/shared';
import { RunHistory } from './history.js';
import { parseOverlayProposal } from './overlay.js';
import { createRunners, detectAvailableAgents } from './runners/index.js';
import { decodeScreenshot, writeScreenshotFile } from './screenshot.js';
import { buildUndoFiles, computeDiff, restoreSnapshot, takeSnapshot, type Snapshot } from './snapshot.js';

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

export interface CreateServerOptions {
  port: number;
  cwd: string;
  /** Defaults to `createRunners()` (Claude + Codex). Overridable for tests. */
  runners?: AgentRunner[];
  /** Origins whose prefix is allowed to open a `/ws` connection. */
  allowedOriginPrefixes?: string[];
  /** Pairing token required on `/ws` connections. Defaults to loading/creating one under `~/.vizion/token`. Overridable for tests. */
  token?: string;
}

export interface VizionServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Actual bound port; only meaningful after start() resolves. Useful for tests using port 0. */
  readonly port: number | null;
  /** Agents detected as available; only meaningful after start() resolves. */
  readonly agents: AgentKind[];
  /** The pairing token required to open `/ws`; only meaningful after start() resolves. */
  readonly token: string | null;
}

/**
 * Loads the pairing token from `~/.vizion/token`, creating it (32 random hex
 * chars, mode 0600 in a 0700 dir) on first run.
 */
async function loadOrCreateToken(): Promise<string> {
  const dir = path.join(os.homedir(), '.vizion');
  const file = path.join(dir, 'token');
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    // Missing or unreadable; fall through and create it.
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(16).toString('hex');
  await fs.writeFile(file, token, { mode: 0o600 });
  return token;
}

/** Constant-time string comparison, safe against timing attacks even when lengths differ. */
function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Tracks the server-wide "only one project operation at a time" reservation
 * that `run` and `undo-run` share (accept/reject also check it, since they
 * touch the working tree while an undo is writing to it). Kept as a small,
 * pure state machine, separate from `activeRun`'s abort-controller bookkeeping,
 * so the acquire/release contract can be unit tested without a real server.
 */
export type OpKind = 'run' | 'undo';

export class OpLock {
  private current: OpKind | null = null;

  get active(): OpKind | null {
    return this.current;
  }

  /** Reserves `kind` if nothing else is active. Returns whether it succeeded. */
  acquire(kind: OpKind): boolean {
    if (this.current) return false;
    this.current = kind;
    return true;
  }

  /** No-op if `kind` isn't the currently held operation. */
  release(kind: OpKind): void {
    if (this.current === kind) this.current = null;
  }
}

async function readFileIfExists(abs: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function isAllowedOrigin(origin: string | undefined, prefixes: string[]): boolean {
  if (!origin) return false;
  return prefixes.some((prefix) => origin.startsWith(prefix));
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function handleHealth(cwd: string, agents: AgentKind[], res: ServerResponse): void {
  const body: {
    name: string;
    version: string;
    cwd: string;
    agents: AgentKind[];
    requiresToken: boolean;
  } = {
    name: 'vizion',
    version: pkg.version,
    cwd,
    agents,
    requiresToken: true,
  };
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
  });
  res.end(JSON.stringify(body));
}

export function createServer(options: CreateServerOptions): VizionServer {
  const { port, cwd } = options;
  const runners = options.runners ?? createRunners();
  const allowedOriginPrefixes = options.allowedOriginPrefixes ?? ['chrome-extension://'];

  // Detected once at start() and cached for the lifetime of the server.
  let detectedAgents: AgentKind[] = [];
  let pairingToken: string | null = options.token ?? null;

  const httpServer = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health' && req.method === 'GET') {
      handleHealth(cwd, detectedAgents, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const wss = new WebSocketServer({ noServer: true });

  // At most one run in flight for the whole server (the project's cwd is
  // shared across every connection), whichever connection started it;
  // tracked so a second `run` from any socket is rejected and so closing
  // the socket that owns it aborts the agent process.
  let activeRun: { ws: WebSocket; controller: AbortController } | null = null;

  // Cross-kind counterpart to `activeRun`: held while a `run` OR an
  // `undo-run` is in flight, so the other kind (and `accept`/`reject`) can
  // refuse instead of racing it.
  const opLock = new OpLock();

  // Accepted runs, kept so their diff can be undone later. Server-wide, like
  // `activeRun`: the history is about the shared project, not a connection.
  const history = new RunHistory();

  // The snapshot from the most recently *finished* run on a connection
  // (diff already sent), plus the paths it touched (what `reject` should
  // restore), the diff itself (what `accept` stores into history) and the
  // run's own metadata (agent/prompt/selectors, for the RunRecord). Set only
  // once the diff has been sent, so its presence means "awaiting
  // accept/reject", not "a run is in progress". Cleared on `accept`,
  // `reject`, or socket close.
  const pendingSnapshots = new Map<
    WebSocket,
    {
      snapshot: Snapshot;
      touchedPaths: string[];
      files: FileDiff[];
      agent: AgentKind;
      prompt: string;
      selectors: string[];
    }
  >();

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/ws' || !isAllowedOrigin(req.headers.origin, allowedOriginPrefixes)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const providedToken = url.searchParams.get('token') ?? '';
    if (!pairingToken || !timingSafeEqualString(providedToken, pairingToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  /** Sends `message` to every currently open connection. */
  function broadcast(message: ServerMessage): void {
    for (const client of wss.clients) {
      send(client, message);
    }
  }

  async function handleRun(
    ws: WebSocket,
    message: Extract<ClientMessage, { type: 'run' }>,
  ): Promise<void> {
    // Project-wide, not just this socket: acceptance order must equal
    // execution order, so a run is refused while ANY connection has an
    // undecided diff.
    if (pendingSnapshots.size > 0) {
      send(ws, { type: 'error', message: "Accepte ou rejette d'abord les modifications en attente." });
      return;
    }
    if (opLock.active === 'undo') {
      send(ws, { type: 'error', message: 'Une opération est déjà en cours.' });
      return;
    }
    if (activeRun) {
      send(ws, { type: 'error', message: 'Un run est déjà en cours.' });
      return;
    }

    // Reserve the slot synchronously (before any `await`) so a second `run`
    // message processed while this one is still resolving is rejected
    // instead of racing it.
    const controller = new AbortController();
    activeRun = { ws, controller };
    opLock.acquire('run');

    const isOverlay = message.mode === 'overlay';
    let overlayTempDir: string | null = null;
    let screenshotDir: string | null = null;

    try {
      const runner = runners.find((candidate) => candidate.kind === message.agent);
      if (!runner || !(await runner.isAvailable())) {
        send(ws, { type: 'error', message: `agent non disponible : ${message.agent}` });
        return;
      }

      let screenshotPath: string | undefined;
      if (message.screenshot) {
        const decoded = decodeScreenshot(message.screenshot.dataUrl);
        if ('error' in decoded) {
          send(ws, { type: 'error', message: decoded.error });
          return;
        }
        screenshotPath = await writeScreenshotFile(decoded.buffer, decoded.ext);
        screenshotDir = path.dirname(screenshotPath);
      }

      const selectors = (message.elements ?? [message.element]).map((el) => el.selector);

      if (isOverlay) {
        // Overlay runs never touch the project: a fresh, empty temp dir
        // stands in for the project cwd, and the runner is told not to use
        // any tools. No snapshot, no diff, no history record.
        overlayTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vizion-overlay-'));
        const request = {
          agent: message.agent,
          prompt: message.prompt,
          element: message.element,
          elements: message.elements,
          pageUrl: message.element.pageUrl,
          cwd: overlayTempDir,
          mode: message.mode,
          readOnly: true,
          screenshotPath,
        };

        let accumulatedText = '';
        for await (const event of runner.run(request, controller.signal)) {
          send(ws, { type: 'event', event });
          if (event.type === 'text') accumulatedText += event.text;
        }

        const result = parseOverlayProposal(accumulatedText, selectors);
        // Clean up before replying so the temp dirs are already gone by the
        // time the client sees the result.
        await fs.rm(overlayTempDir, { recursive: true, force: true }).catch(() => {});
        overlayTempDir = null;
        if (screenshotDir) {
          await fs.rm(screenshotDir, { recursive: true, force: true }).catch(() => {});
          screenshotDir = null;
        }
        if ('error' in result) {
          send(ws, { type: 'error', message: result.error });
        } else {
          send(ws, {
            type: 'overlay-proposal',
            overrides: result.overrides,
            ...(result.note ? { note: result.note } : {}),
          });
        }
        return;
      }

      const request = {
        agent: message.agent,
        prompt: message.prompt,
        element: message.element,
        // Carried through (untyped on `RunRequest` itself) so `buildPrompt`
        // can describe every selected element when there is more than one.
        elements: message.elements,
        pageUrl: message.element.pageUrl,
        cwd,
        screenshotPath,
      };

      const snapshot = await takeSnapshot(cwd);

      try {
        for await (const event of runner.run(request, controller.signal)) {
          send(ws, { type: 'event', event });
        }
      } finally {
        // Screenshot cleanup before the diff so the file is already gone by
        // the time the client sees it (matches the overlay-mode ordering).
        if (screenshotDir) {
          await fs.rm(screenshotDir, { recursive: true, force: true }).catch(() => {});
          screenshotDir = null;
        }
        // Diff after the run finishes, whether it completed, errored, or was aborted.
        try {
          const files = await computeDiff(snapshot);
          pendingSnapshots.set(ws, {
            snapshot,
            touchedPaths: files.map((file) => file.path),
            files,
            agent: message.agent,
            prompt: message.prompt,
            selectors,
          });
          send(ws, { type: 'diff', files });
        } catch (diffErr) {
          send(ws, {
            type: 'error',
            message: diffErr instanceof Error ? diffErr.message : 'échec du calcul du diff',
          });
        }
      }
    } catch (err) {
      send(ws, { type: 'error', message: err instanceof Error ? err.message : "l'exécution de l'agent a échoué" });
    } finally {
      if (overlayTempDir) {
        await fs.rm(overlayTempDir, { recursive: true, force: true }).catch(() => {});
      }
      if (screenshotDir) {
        await fs.rm(screenshotDir, { recursive: true, force: true }).catch(() => {});
      }
      if (activeRun?.ws === ws) {
        activeRun = null;
        opLock.release('run');
      }
    }
  }

  /**
   * Restores the byte-exact pre-run content (and POSIX mode) of every file
   * an accepted run touched, using the before/after snapshot captured at
   * `accept` time. Refuses without changing anything if any touched file no
   * longer matches what the run left behind (edited or recreated since).
   * Only the most recent still-accepted run may be undone, since an older
   * run's "after" state can no longer be trusted once a newer run has
   * touched the same files.
   */
  async function handleUndoRun(ws: WebSocket, id: string): Promise<void> {
    if (opLock.active === 'undo') {
      send(ws, { type: 'error', message: 'Une opération est déjà en cours.' });
      return;
    }
    if (activeRun || pendingSnapshots.size > 0) {
      send(ws, { type: 'error', message: "Termine le run en cours d'abord." });
      return;
    }
    const entry = history.get(id);
    if (!entry) {
      send(ws, { type: 'error', message: 'Run introuvable.' });
      return;
    }
    if (entry.record.status === 'undone') {
      send(ws, { type: 'error', message: 'Ce run a déjà été annulé.' });
      return;
    }
    const mostRecentAccepted = history.list().find((run) => run.status === 'accepted');
    if (mostRecentAccepted?.id !== id) {
      send(ws, { type: 'error', message: "Annule d'abord les runs plus récents." });
      return;
    }

    // Reserve synchronously (before the first `await`) so a second
    // `undo-run` processed while this one is still resolving is rejected
    // instead of racing it.
    opLock.acquire('undo');
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
      const root = stdout.trim();

      // Verify every touched file still matches what the run left behind
      // before writing anything back.
      for (const file of entry.files) {
        const abs = path.join(root, file.path);
        const current = await readFileIfExists(abs);
        const matches =
          file.after === null ? current === null : current !== null && current.equals(file.after.content);
        if (!matches) {
          send(ws, {
            type: 'error',
            message: `Conflit : ${file.path} a été modifié depuis ce run. Annulation impossible.`,
          });
          return;
        }
      }

      for (const file of entry.files) {
        const abs = path.join(root, file.path);
        if (file.before === null) {
          await fs.rm(abs, { force: true });
        } else {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, file.before.content);
          if (process.platform !== 'win32') await fs.chmod(abs, file.before.mode);
        }
      }

      history.markUndone(id);
      send(ws, { type: 'run-undone', id, files: entry.record.files });
      broadcast({ type: 'history', runs: history.list() });
    } catch (err) {
      const execErr = err as { stderr?: string; message?: string };
      const firstLine = execErr.stderr
        ?.split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      send(ws, {
        type: 'error',
        message: `Échec de l'annulation du run : ${firstLine ?? execErr.message ?? 'erreur inconnue'}`,
      });
    } finally {
      opLock.release('undo');
    }
  }

  async function handleClientMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ping':
          send(ws, { type: 'pong' });
          return;
        case 'accept': {
          if (opLock.active === 'undo') {
            send(ws, { type: 'error', message: 'Une opération est déjà en cours.' });
            return;
          }
          const pending = pendingSnapshots.get(ws);
          if (!pending) {
            send(ws, { type: 'error', message: 'rien à accepter ou rejeter' });
            return;
          }
          pendingSnapshots.delete(ws);
          const undoFiles = await buildUndoFiles(pending.snapshot, pending.touchedPaths);
          history.add(
            {
              agent: pending.agent,
              prompt: pending.prompt,
              selectors: pending.selectors,
              createdAt: Date.now(),
              files: pending.files.map((file) => file.path),
              status: 'accepted',
            },
            undoFiles,
          );
          send(ws, { type: 'diff', files: [] });
          broadcast({ type: 'history', runs: history.list() });
          return;
        }
        case 'reject': {
          if (opLock.active === 'undo') {
            send(ws, { type: 'error', message: 'Une opération est déjà en cours.' });
            return;
          }
          const pending = pendingSnapshots.get(ws);
          if (!pending) {
            send(ws, { type: 'error', message: 'rien à accepter ou rejeter' });
            return;
          }
          pendingSnapshots.delete(ws);
          const { restored, skipped } = await restoreSnapshot(pending.snapshot, pending.touchedPaths);
          send(ws, { type: 'restored', files: restored });
          if (skipped.length > 0) {
            send(ws, {
              type: 'error',
              message: `Fichiers trop volumineux non restaurés : ${skipped.join(', ')}`,
            });
          }
          send(ws, { type: 'diff', files: [] });
          broadcast({ type: 'history', runs: history.list() });
          return;
        }
        case 'run':
          await handleRun(ws, message);
          return;
        case 'undo-run':
          await handleUndoRun(ws, message.id);
          return;
        case 'list-history':
          send(ws, { type: 'history', runs: history.list() });
          return;
        default:
          send(ws, { type: 'error', message: 'type de message inconnu' });
      }
    } catch (err) {
      send(ws, { type: 'error', message: err instanceof Error ? err.message : 'erreur interne' });
    }
  }

  wss.on('connection', (ws: WebSocket) => {
    send(ws, { type: 'hello', version: pkg.version, cwd, agents: detectedAgents });
    send(ws, { type: 'history', runs: history.list() });

    ws.on('message', (data: Buffer) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(data.toString('utf8')) as ClientMessage;
      } catch {
        send(ws, { type: 'error', message: 'message JSON invalide' });
        return;
      }
      void handleClientMessage(ws, message);
    });

    ws.on('close', () => {
      if (activeRun?.ws === ws) {
        activeRun.controller.abort();
        activeRun = null;
        opLock.release('run');
      }
      pendingSnapshots.delete(ws);
    });
  });

  let boundPort: number | null = null;

  return {
    async start(): Promise<void> {
      if (!pairingToken) {
        pairingToken = await loadOrCreateToken();
      }
      detectedAgents = await detectAvailableAgents(runners);
      await new Promise<void>((resolve) => {
        httpServer.listen(port, '127.0.0.1', () => {
          const addr = httpServer.address();
          boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
          resolve();
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        wss.close();
        httpServer.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    },
    get port(): number | null {
      return boundPort;
    },
    get agents(): AgentKind[] {
      return detectedAgents;
    },
    get token(): string | null {
      return pairingToken;
    },
  };
}
