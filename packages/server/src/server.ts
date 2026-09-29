import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { overrideKey, type AgentKind, type AgentRunner, type ClientMessage, type ServerMessage, type SessionRun } from '@vizion/shared';
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

function sendSocket(ws: WebSocket, message: ServerMessage): void {
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

  // The first socket is only a stable owner key. Work belongs to the
  // authenticated panel session, not to the lifetime of its current socket.
  interface Session {
    id: string;
    owner: WebSocket;
    socket: WebSocket | null;
    run: SessionRun | null;
    timer?: ReturnType<typeof setTimeout>;
  }
  const sessions = new Map<string, Session>();
  const owners = new Map<WebSocket, Session>();
  let stopping = false;
  let decisionOwner: Session | null = null;
  const RECONNECT_GRACE_MS = 60_000;
  const MAX_SAVED_EVENTS = 1000;
  const MAX_EVENT_TEXT = 16_384;

  function send(owner: WebSocket, message: ServerMessage): void {
    const session = owners.get(owner);
    if (!session) {
      sendSocket(owner, message);
      return;
    }
    const run = session.run;
    if (run) {
      switch (message.type) {
        case 'event': {
          const event = message.event;
          run.events.push(event.type === 'text'
            ? { ...event, text: event.text.slice(-MAX_EVENT_TEXT) }
            : event);
          if (run.events.length > MAX_SAVED_EVENTS) run.events.shift();
          if (event.type === 'done') {
            run.running = false;
            run.exitCode = event.exitCode;
          } else if (event.type === 'error') {
            run.running = false;
            run.error = event.message;
          }
          break;
        }
        case 'overlay-proposal':
          run.proposal = { overrides: message.overrides, note: message.note, pageKey: run.pageKey };
          break;
        case 'error': run.running = false; run.error = message.message; break;
        default: break;
      }
    }
    if (session.socket) sendSocket(session.socket, message);
  }

  function detach(session: Session): void {
    session.socket = null;
    if (session.timer) clearTimeout(session.timer);
    if (stopping) return;
    if (stopping) return;
    session.timer = setTimeout(() => {
      // A temporary loss of contact is not a cancellation. After a minute
      // without the panel, stop the agent, but retain its diff for review.
      if (activeRun?.ws === session.owner) {
        activeRun.controller.abort();
        return;
      }
      if (decisions.exists && decisionOwner === session) return;
      sessions.delete(session.id);
      owners.delete(session.owner);
    }, RECONNECT_GRACE_MS);
    session.timer.unref();
  }

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/ws' || !isAllowedOrigin(req.headers.origin, allowedOriginPrefixes)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get('session');
    if (sessionId !== null && !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const providedToken = url.searchParams.get('token') ?? '';
    if (!pairingToken || !timingSafeEqualString(providedToken, pairingToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, sessionId));
  });

  function broadcast(message: ServerMessage): void {
    for (const client of wss.clients) sendSocket(client, message);
  }

  async function handleClientMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
    const reply = (response: ServerMessage) => send(ws, response);
    switch (message.type) {
      case 'dismiss-proposal': {
        const session = owners.get(ws);
        if (session?.run) session.run.proposal = null;
        return;
      }
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
          const session = owners.get(ws);
          if (session) {
            session.run = {
              agent: message.agent, pageKey: overrideKey(message.element.pageUrl),
              running: true, events: [], proposal: null, error: null, exitCode: null,
            };
            if (message.mode !== 'overlay') decisionOwner = session;
          }
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
      if (kind === 'run') {
        activeRun = null;
        const session = owners.get(ws);
        if (session && !session.socket) detach(session);
      }
      if (!decisions.exists && kind !== 'run') decisionOwner = null;
      opLock.release(kind);
    }
  }

  wss.on('connection', (ws: WebSocket, sessionId: string | null) => {
    let session: Session | undefined;
    if (sessionId) {
      session = sessions.get(sessionId);
      if (!session) {
        session = { id: sessionId, owner: ws, socket: ws, run: null };
        sessions.set(sessionId, session);
        owners.set(ws, session);
      } else {
        if (session.timer) clearTimeout(session.timer);
        const previous = session.socket;
        session.socket = ws;
        previous?.close();
      }
    }
    const owner = session?.owner ?? ws;
    sendSocket(ws, { type: 'hello', version: pkg.version, cwd, agents: detectedAgents });
    sendSocket(ws, { type: 'history', runs: history.list() });
    if (session) sendSocket(ws, { type: 'session', run: session.run });
    const pending = decisions.current();
    if (pending) sendSocket(ws, pending);

    ws.on('message', (data: Buffer) => {
      // Late traffic from the replaced transport cannot start or alter work.
      if (session && session.socket !== ws) return;
      let message: ClientMessage;
      try {
        message = JSON.parse(data.toString('utf8')) as ClientMessage;
      } catch {
        send(owner, { type: 'error', message: 'message JSON invalide' });
        return;
      }
      const task = handleClientMessage(owner, message);
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    });

    ws.on('close', () => {
      if (session) {
        if (session.socket === ws) detach(session);
        return;
      }
      if (activeRun?.ws === ws) {
        activeRun.controller.abort();
      }
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
      stopping = true;
      activeRun?.controller.abort();
      for (const session of sessions.values()) {
        if (session.timer) clearTimeout(session.timer);
        session.socket = null;
      }
      for (const client of wss.clients) client.terminate();
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
