import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentKind, AgentRunner, ClientMessage, ServerMessage } from '@vizion/shared';
import { createRunners, detectAvailableAgents } from './runners/index.js';
import { computeDiff, restoreSnapshot, takeSnapshot, type Snapshot } from './snapshot.js';

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

  // The snapshot from the most recently *finished* run on a connection
  // (diff already sent), plus the paths it touched (what `reject` should
  // restore). Set only once the diff has been sent, so its presence means
  // "awaiting accept/reject", not "a run is in progress". Cleared on
  // `accept`, `reject`, or socket close.
  const pendingSnapshots = new Map<WebSocket, { snapshot: Snapshot; touchedPaths: string[] }>();

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

  async function handleRun(
    ws: WebSocket,
    message: Extract<ClientMessage, { type: 'run' }>,
  ): Promise<void> {
    if (pendingSnapshots.has(ws)) {
      send(ws, { type: 'error', message: "Accepte ou rejette d'abord les modifications en attente." });
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

    try {
      const runner = runners.find((candidate) => candidate.kind === message.agent);
      if (!runner || !(await runner.isAvailable())) {
        send(ws, { type: 'error', message: `agent non disponible : ${message.agent}` });
        return;
      }

      const request = {
        agent: message.agent,
        prompt: message.prompt,
        element: message.element,
        pageUrl: message.element.pageUrl,
        cwd,
      };

      const snapshot = await takeSnapshot(cwd);

      try {
        for await (const event of runner.run(request, controller.signal)) {
          send(ws, { type: 'event', event });
        }
      } finally {
        // Diff after the run finishes, whether it completed, errored, or was aborted.
        try {
          const files = await computeDiff(snapshot);
          pendingSnapshots.set(ws, { snapshot, touchedPaths: files.map((file) => file.path) });
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
      if (activeRun?.ws === ws) activeRun = null;
    }
  }

  async function handleClientMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ping':
          send(ws, { type: 'pong' });
          return;
        case 'accept': {
          if (!pendingSnapshots.delete(ws)) {
            send(ws, { type: 'error', message: 'rien à accepter ou rejeter' });
            return;
          }
          send(ws, { type: 'diff', files: [] });
          return;
        }
        case 'reject': {
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
          return;
        }
        case 'run':
          await handleRun(ws, message);
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
