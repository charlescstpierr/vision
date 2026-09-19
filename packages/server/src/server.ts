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
import { createPairingCode, renderPairingPage } from './pairing.js';
import { createRunners, detectAvailableAgents } from './runners/index.js';
import { decodeScreenshot, writeScreenshotFile } from './screenshot.js';
import { buildUndoFiles, computeDiff, takeSnapshot } from './snapshot.js';

const execFileAsync = promisify(execFile);

/**
 * How long an agent run may stay in flight before the server aborts it.
 * Without this, an agent that hangs holds the project-wide `OpLock`
 * forever and nothing else -- not even an undo -- can run again.
 */
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** Renders a timeout for humans: minutes once it reaches one, seconds below. */
function formatTimeout(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

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
  /** Milliseconds before an in-flight run is aborted. Defaults to 10 minutes; overridable for tests. */
  runTimeoutMs?: number;
  /** Where run history is stored. Defaults to `~/.vizion/history`; overridden by tests so they never touch the real one. */
  historyRoot?: string;
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
  /** Code guarding `/pair`, for the one-click pairing URL. Only meaningful after start() resolves. */
  readonly pairingCode: string | null;
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
  // No `Access-Control-Allow-Origin`: the side panel reaches the server over
  // `/ws`, never over `fetch`, so nothing legitimate needs cross-origin reads
  // here. With the wildcard, any page the user happened to have open could
  // read back `cwd` (an absolute path on their machine) and the list of
  // installed agents. Direct clients such as `curl` are unaffected.
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createServer(options: CreateServerOptions): VizionServer {
  const { port, cwd } = options;
  const runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const runners = options.runners ?? createRunners();
  const allowedOriginPrefixes = options.allowedOriginPrefixes ?? ['chrome-extension://'];

  // Detected once at start() and cached for the lifetime of the server.
  let detectedAgents: AgentKind[] = [];
  let pairingToken: string | null = options.token ?? null;
  // Guards `/pair`, so only someone who can read the server's own stdout can
  // make it hand out the connection token. Valid for as long as the process
  // runs -- no expiry, so reloading the pairing page always works.
  let pairingCode: string | null = null;

  const httpServer = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    if (url.pathname === '/health' && req.method === 'GET') {
      handleHealth(cwd, detectedAgents, res);
      return;
    }
    if (url.pathname === '/pair' && req.method === 'GET') {
      const provided = url.searchParams.get('c') ?? '';
      if (!pairingCode || !timingSafeEqualString(provided, pairingCode)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end("Code d'appairage invalide. Relance `vizion` et rouvre l'URL affichée.");
        return;
      }
      const html = renderPairingPage({
        token: pairingToken ?? '',
        port: boundPort ?? port,
        cwd,
        version: pkg.version,
      });
      // No CORS header and no framing: the content script only honours this
      // payload in a top-level loopback document, and `DENY` stops a remote
      // page from embedding it to harvest the token in the first place.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'no-store',
      });
      res.end(html);
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

  // Applied runs, kept so they can be undone later. Server-wide, like
  // `activeRun`: the history is about the shared project, not a connection.
  // Opened in `start()` because it reads what a previous server left on disk;
  // every use below sits in a handler that cannot fire before then.
  let history!: RunHistory;

  // The diff of the most recent run, replayed to a panel that connects later.
  // Informational only: the agent runs in auto-edit mode, so by the time a
  // diff exists the files are already written and the dev server has already
  // reloaded. Taking it back is what `undo-run` is for.
  let lastDiff: FileDiff[] = [];

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

    // Abort the run if it outlives `runTimeoutMs`. The `finally` below still
    // diffs and hands back whatever the agent managed to write, so a timed-out
    // run is reviewable (and rejectable) like any other.
    const timeoutTimer = setTimeout(() => {
      if (activeRun?.controller !== controller) return;
      // Broadcast, not `send`: the panel that started the run may have closed,
      // and the timeout concerns the project either way.
      broadcast({
        type: 'error',
        message: `Run interrompu : délai de ${formatTimeout(runTimeoutMs)} dépassé.`,
      });
      controller.abort();
    }, runTimeoutMs);

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
        // Diff after the run finishes, whether it completed, errored, or was
        // aborted, and record it straight away. The files are already written
        // by then, so there is nothing to approve -- only something to undo.
        try {
          const files = await computeDiff(snapshot);
          lastDiff = files;
          let recorded = false;
          if (files.length > 0) {
            const undoFiles = await buildUndoFiles(
              snapshot,
              files.map((file) => file.path),
            );
            const stored = await history.add(
              {
                agent: message.agent,
                prompt: message.prompt,
                selectors,
                createdAt: Date.now(),
                files: files.map((file) => file.path),
                status: 'applied',
              },
              undoFiles,
              snapshot.headSha,
            );
            recorded = stored !== null;
            if (!recorded) {
              // The edits are on disk either way; what failed is our ability
              // to take them back, which the user needs to know now rather
              // than when they try.
              send(ws, {
                type: 'error',
                message: "Run appliqué, mais non enregistré dans l'historique : annulation indisponible.",
              });
            }
          }
          // Diff first: it is the result of the run. The refreshed history
          // follows only when there is actually a new entry in it.
          broadcast({ type: 'diff', files });
          if (recorded) broadcast({ type: 'history', runs: history.list() });
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
      clearTimeout(timeoutTimer);
      if (activeRun?.controller === controller) {
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
  async function handleUndoRun(ws: WebSocket, id: string, force: boolean): Promise<void> {
    if (opLock.active === 'undo') {
      send(ws, { type: 'error', message: 'Une opération est déjà en cours.' });
      return;
    }
    if (activeRun) {
      send(ws, { type: 'error', message: "Termine le run en cours d'abord." });
      return;
    }
    const entry = await history.get(id);
    if (!entry) {
      send(ws, { type: 'error', message: 'Run introuvable.' });
      return;
    }
    if (entry.record.status === 'undone') {
      send(ws, { type: 'error', message: 'Ce run a déjà été annulé.' });
      return;
    }
    const mostRecentApplied = history.list().find((run) => run.status === 'applied');
    if (mostRecentApplied?.id !== id) {
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
      // before writing anything back. A mismatch is reported rather than
      // refused outright: a formatter running on save is as likely a cause as
      // a real edit, and the user is the only one who can tell them apart.
      if (!force) {
        const diverged: string[] = [];
        for (const file of entry.files) {
          const abs = path.join(root, file.path);
          const current = await readFileIfExists(abs);
          const matches =
            file.after === null ? current === null : current !== null && current.equals(file.after.content);
          if (!matches) diverged.push(file.path);
        }
        if (diverged.length > 0) {
          send(ws, { type: 'undo-conflict', id, files: diverged });
          return;
        }
      }

      // Nothing has been written yet, so the conflict check above could still
      // bail out without a trace. From here on the undo actually happens.
      //
      // The agent may have committed while it worked. Restoring file contents
      // alone would take the edits back but leave those commits on the branch,
      // so move HEAD back first, keeping the working tree for the restore
      // below to overwrite.
      if (entry.headSha) {
        const { stdout: headOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
        if (headOut.trim() !== entry.headSha) {
          await execFileAsync('git', ['reset', '--mixed', entry.headSha], { cwd: root });
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

      await history.markUndone(id);
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
        case 'cancel': {
          if (!activeRun) {
            send(ws, { type: 'error', message: 'Aucun run en cours.' });
            return;
          }
          // Any connection may cancel: the run holds the project-wide lock, so
          // the panel that started it may well be gone by now.
          broadcast({ type: 'error', message: 'Run annulé.' });
          activeRun.controller.abort();
          return;
        }
        case 'run':
          await handleRun(ws, message);
          return;
        case 'undo-run':
          await handleUndoRun(ws, message.id, message.force === true);
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
    // Show a panel that connects later what the last run changed.
    if (lastDiff.length > 0) send(ws, { type: 'diff', files: lastDiff });

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
      // Abort only. Clearing `activeRun` and releasing the lock here would free
      // the project while the agent process is still winding down, letting the
      // next run start against a half-finished tree and then overwrite
      // `pendingRun` from the old one. `handleRun`'s `finally` owns that.
      if (activeRun?.ws === ws) activeRun.controller.abort();
    });
  });

  let boundPort: number | null = null;

  return {
    async start(): Promise<void> {
      if (!pairingToken) {
        pairingToken = await loadOrCreateToken();
      }
      pairingCode = createPairingCode();
      // Key the history on the repo root when there is one, so running the
      // server from a subdirectory finds the same project's runs.
      let projectPath = cwd;
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
        projectPath = stdout.trim() || cwd;
      } catch {
        // Not a git repo: the cwd is the best key available.
      }
      history = await RunHistory.open(projectPath, options.historyRoot);
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
    get pairingCode(): string | null {
      return pairingCode;
    },
  };
}
