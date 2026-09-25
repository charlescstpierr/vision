import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentKind, AgentRunner, ClientMessage, ServerMessage } from '@vizion/shared';
import { Decisions, DecisionError } from './decisions.js';
import { RunHistory } from './history.js';
import { executeRun } from './run.js';
import { createRunners, detectAvailableAgents } from './runners/index.js';
import { undoRun } from './undo.js';

export type OpKind = 'run' | 'undo' | 'accept' | 'reject' | 'retry-diff';

/** Synchronous project reservation, held across every asynchronous mutation. */
export class OpLock {
  private current: OpKind | null = null;
  get active(): OpKind | null { return this.current; }
  acquire(kind: OpKind): boolean {
    if (this.current) return false;
    this.current = kind;
    return true;
  }
  release(kind: OpKind): void {
    if (this.current === kind) this.current = null;
  }
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
  /** Pairing token; defaults to loading/creating one under `~/.vizion/token`. */
  token?: string;
}

export interface VizionServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Actual bound port; only meaningful after start() resolves. */
  readonly port: number | null;
  readonly agents: AgentKind[];
  readonly token: string | null;
}

async function loadOrCreateToken(): Promise<string> {
  const dir = path.join(os.homedir(), '.vizion');
  const file = path.join(dir, 'token');
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim();
    if (existing) return existing;
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(16).toString('hex');
  await fs.writeFile(file, token, { mode: 0o600 });
  return token;
}

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
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function handleHealth(cwd: string, agents: AgentKind[], res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
  });
  res.end(JSON.stringify({ name: 'vizion', version: pkg.version, cwd, agents, requiresToken: true }));
}

export function createServer(options: CreateServerOptions): VizionServer {
  const { port, cwd } = options;
  const runners = options.runners ?? createRunners();
  const allowedOriginPrefixes = options.allowedOriginPrefixes ?? ['chrome-extension://'];
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
  let activeRun: { ws: WebSocket; controller: AbortController } | null = null;
  const opLock = new OpLock();
  const history = new RunHistory();
  const decisions = new Decisions(history, broadcast);
  const inFlight = new Set<Promise<void>>();

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
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  function broadcast(message: ServerMessage): void {
    for (const client of wss.clients) send(client, message);
  }

  async function handleClientMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
    const reply = (response: ServerMessage) => send(ws, response);
    switch (message.type) {
      case 'ping': reply({ type: 'pong' }); return;
      case 'list-history': reply({ type: 'history', runs: history.list() }); return;
      case 'run':
        if (decisions.exists) {
          reply({ type: 'error', message: "Accepte ou rejette d'abord les modifications en attente." });
          return;
        }
        break;
      case 'undo-run':
        if (decisions.exists || activeRun) {
          reply({ type: 'error', message: "Termine le run en cours d'abord." });
          return;
        }
        break;
      case 'accept':
      case 'reject':
      case 'retry-diff': break;
      default:
        reply({ type: 'error', message: 'type de message inconnu' });
        return message satisfies never;
    }
    const kind = message.type === 'undo-run' ? 'undo' : message.type;
    if (!opLock.acquire(kind)) {
      reply({ type: 'error', message: activeRun && kind === 'run' ? 'Un run est déjà en cours.' : 'Une opération est déjà en cours.' });
      return;
    }
    try {
      switch (message.type) {
        case 'run': {
          const controller = new AbortController();
          activeRun = { ws, controller };
          await executeRun({ cwd, runners, decisions }, message, { signal: controller.signal, send: reply });
          return;
        }
        case 'undo-run':
          await undoRun({ cwd, history, broadcast }, message.id, reply);
          return;
        case 'accept':
        case 'reject':
        case 'retry-diff':
          await decisions.resolve(message, reply);
          return;
        default: return message satisfies never;
      }
    } catch (err) {
      reply(err instanceof DecisionError ? err.response : { type: 'error', message: err instanceof Error ? err.message : 'erreur interne' });
    } finally {
      // Preserve the abort reservation: socket close never releases a running agent's slot.
      if (kind === 'run') activeRun = null;
      opLock.release(kind);
    }
  }

  wss.on('connection', (ws: WebSocket) => {
    send(ws, { type: 'hello', version: pkg.version, cwd, agents: detectedAgents });
    send(ws, { type: 'history', runs: history.list() });
    const pending = decisions.current();
    if (pending) send(ws, pending);
    ws.on('message', (data: Buffer) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(data.toString('utf8')) as ClientMessage;
        if (!message || typeof message !== 'object') throw new TypeError('message invalide');
      } catch (err) {
        send(ws, { type: 'error', message: err instanceof Error ? 'message JSON invalide' : 'message invalide' });
        return;
      }
      const task = handleClientMessage(ws, message);
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    });
    ws.on('close', () => {
      if (activeRun?.ws === ws) activeRun.controller.abort();
    });
  });

  let boundPort: number | null = null;
  return {
    async start(): Promise<void> {
      if (!pairingToken) pairingToken = await loadOrCreateToken();
      detectedAgents = await detectAvailableAgents(runners);
      await new Promise<void>((resolve) => {
        httpServer.listen(port, '127.0.0.1', () => {
          const addr = httpServer.address();
          boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
          resolve();
        });
      });
    },
    async stop(): Promise<void> {
      activeRun?.controller.abort();
      wss.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err?: Error) => (err ? reject(err) : resolve()));
      });
      await Promise.all(inFlight);
    },
    get port() { return boundPort; },
    get agents() { return detectedAgents; },
    get token() { return pairingToken; },
  };
}
