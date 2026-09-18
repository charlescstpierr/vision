import { createRequire } from 'node:module';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentKind, AgentRunner, ClientMessage, ServerMessage } from '@vizion/shared';
import { createRunners, detectAvailableAgents } from './runners/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

export interface CreateServerOptions {
  port: number;
  cwd: string;
  /** Defaults to `createRunners()` (Claude + Codex). Overridable for tests. */
  runners?: AgentRunner[];
  /** Origins whose prefix is allowed to open a `/ws` connection. */
  allowedOriginPrefixes?: string[];
}

export interface VizionServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Actual bound port; only meaningful after start() resolves. Useful for tests using port 0. */
  readonly port: number | null;
  /** Agents detected as available; only meaningful after start() resolves. */
  readonly agents: AgentKind[];
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
  const body: { name: string; version: string; cwd: string; agents: AgentKind[] } = {
    name: 'vizion',
    version: pkg.version,
    cwd,
    agents,
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

  const httpServer = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health' && req.method === 'GET') {
      handleHealth(cwd, detectedAgents, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const wss = new WebSocketServer({ noServer: true });

  // One in-flight run per connection at most; tracked so a second `run`
  // is rejected and so closing the socket aborts the agent process.
  const activeRuns = new WeakMap<WebSocket, AbortController>();

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (req.url !== '/ws' || !isAllowedOrigin(req.headers.origin, allowedOriginPrefixes)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
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
    if (activeRuns.has(ws)) {
      send(ws, { type: 'error', message: 'a run is already active on this connection' });
      return;
    }

    // Reserve the slot synchronously (before any `await`) so a second `run`
    // message processed while this one is still resolving is rejected
    // instead of racing it.
    const controller = new AbortController();
    activeRuns.set(ws, controller);

    try {
      const runner = runners.find((candidate) => candidate.kind === message.agent);
      if (!runner || !(await runner.isAvailable())) {
        send(ws, { type: 'error', message: `agent "${message.agent}" is not available` });
        return;
      }

      const request = {
        agent: message.agent,
        prompt: message.prompt,
        element: message.element,
        pageUrl: message.element.pageUrl,
        cwd,
      };
      for await (const event of runner.run(request, controller.signal)) {
        send(ws, { type: 'event', event });
      }
    } catch (err) {
      send(ws, { type: 'error', message: err instanceof Error ? err.message : 'agent run failed' });
    } finally {
      activeRuns.delete(ws);
    }
  }

  async function handleClientMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ping':
          send(ws, { type: 'pong' });
          return;
        case 'accept':
        case 'reject':
          send(ws, { type: 'error', message: 'not implemented yet' });
          return;
        case 'run':
          await handleRun(ws, message);
          return;
        default:
          send(ws, { type: 'error', message: 'unknown message type' });
      }
    } catch (err) {
      send(ws, { type: 'error', message: err instanceof Error ? err.message : 'internal error' });
    }
  }

  wss.on('connection', (ws: WebSocket) => {
    send(ws, { type: 'hello', version: pkg.version, cwd, agents: detectedAgents });

    ws.on('message', (data: Buffer) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(data.toString('utf8')) as ClientMessage;
      } catch {
        send(ws, { type: 'error', message: 'invalid JSON' });
        return;
      }
      void handleClientMessage(ws, message);
    });

    ws.on('close', () => {
      activeRuns.get(ws)?.abort();
      activeRuns.delete(ws);
    });
  });

  let boundPort: number | null = null;

  return {
    async start(): Promise<void> {
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
  };
}
