import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AgentEvent, AgentRunner, ServerMessage } from '@vizion/shared';
import { createServer } from './server.js';

const execFileAsync = promisify(execFile);
const TEST_TOKEN = 'a'.repeat(32);
const TEST_ORIGIN = 'http://test';

function wsUrl(port: number | null, token: string = TEST_TOKEN): string {
  return `ws://127.0.0.1:${port}/ws?token=${token}`;
}

describe('server', () => {
  it('serves /health with the expected shape, without requiring a token', async () => {
    const cwd = process.cwd();
    const server = createServer({ port: 0, cwd, runners: [], token: TEST_TOKEN });
    await server.start();
    try {
      const port = server.port;
      expect(port).toBeTypeOf('number');
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        name: string;
        version: string;
        cwd: string;
        agents: unknown[];
        requiresToken: boolean;
      };
      expect(body.name).toBe('vizion');
      expect(typeof body.version).toBe('string');
      expect(body.cwd).toBe(cwd);
      expect(Array.isArray(body.agents)).toBe(true);
      expect(body.requiresToken).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

class FakeRunner implements AgentRunner {
  readonly kind = 'claude' as const;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async *run(): AsyncIterable<AgentEvent> {
    yield { type: 'started', agent: 'claude' };
    yield { type: 'text', text: 'hello' };
    yield { type: 'text', text: 'world' };
    yield { type: 'done', exitCode: 0 };
  }
}

/**
 * Buffers every message from the moment it's created, so awaiting messages
 * one at a time later can never miss one that arrived early (e.g. `hello`
 * arriving before the first `await` in a test gets a chance to attach a
 * listener).
 */
function createMessageReader(ws: WebSocket): { next(): Promise<ServerMessage> } {
  const queue: ServerMessage[] = [];
  let waiter: (() => void) | null = null;

  ws.on('message', (data: Buffer) => {
    queue.push(JSON.parse(data.toString('utf8')) as ServerMessage);
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve();
    }
  });

  return {
    async next(): Promise<ServerMessage> {
      while (queue.length === 0) {
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
      return queue.shift() as ServerMessage;
    },
  };
}

/** Opens a socket and attaches the message reader before awaiting `open`, so a
 *  `hello` that arrives right away is never missed. */
async function openSocket(
  port: number | null,
  token: string = TEST_TOKEN,
): Promise<{ ws: WebSocket; reader: ReturnType<typeof createMessageReader> }> {
  const ws = new WebSocket(wsUrl(port, token), { headers: { Origin: TEST_ORIGIN } });
  const reader = createMessageReader(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, reader };
}

const element = {
  selector: '#btn',
  tagName: 'button',
  classes: [],
  textContent: 'Go',
  outerHtml: '<button id="btn">Go</button>',
  domPath: ['html', 'body', '#btn'],
  rect: { x: 0, y: 0, width: 10, height: 10 },
  computedStyles: {},
  pageUrl: 'https://example.com',
};

describe('server websocket', () => {
  it('streams agent events over /ws, rejects concurrent runs, and rejects bad origins', async () => {
    const cwd = process.cwd();
    const server = createServer({
      port: 0,
      cwd,
      runners: [new FakeRunner()],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const port = server.port;
      const { ws, reader } = await openSocket(port);

      const hello = await reader.next();
      expect(hello).toEqual({
        type: 'hello',
        version: expect.any(String),
        cwd,
        agents: ['claude'],
      });

      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'make it blue', element }));

      // 4 agent events, then the post-run diff (empty: the FakeRunner never
      // touches any file). Drained fully so the run's slot is freed before
      // the next `run` is sent (its diffing does a few real `git` spawns).
      const received: ServerMessage[] = [];
      while (received.length < 5) {
        received.push(await reader.next());
      }
      expect(received).toEqual([
        { type: 'event', event: { type: 'started', agent: 'claude' } },
        { type: 'event', event: { type: 'text', text: 'hello' } },
        { type: 'event', event: { type: 'text', text: 'world' } },
        { type: 'event', event: { type: 'done', exitCode: 0 } },
        { type: 'diff', files: [] },
      ]);

      // A pending (undecided) diff must block a new run.
      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'p1', element }));
      const blocked = await reader.next();
      expect(blocked).toEqual({
        type: 'error',
        message: "Accepte ou rejette d'abord les modifications en attente.",
      });

      ws.send(JSON.stringify({ type: 'accept' }));
      expect(await reader.next()).toEqual({ type: 'diff', files: [] });

      ws.close();

      // Bad origin: the upgrade must fail.
      const badWs = new WebSocket(wsUrl(port), {
        headers: { Origin: 'http://evil.example' },
      });
      const badResult = await new Promise<'open' | 'error'>((resolve) => {
        badWs.once('open', () => resolve('open'));
        badWs.once('error', () => resolve('error'));
        badWs.once('unexpected-response', () => resolve('error'));
      });
      expect(badResult).toBe('error');
    } finally {
      await server.stop();
    }
  });

  it('rejects the /ws upgrade without a token, and with the wrong token', async () => {
    const cwd = process.cwd();
    const server = createServer({
      port: 0,
      cwd,
      runners: [new FakeRunner()],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();
    try {
      const port = server.port;

      const noTokenWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: TEST_ORIGIN } });
      const noTokenResult = await new Promise<'open' | 'error'>((resolve) => {
        noTokenWs.once('open', () => resolve('open'));
        noTokenWs.once('error', () => resolve('error'));
        noTokenWs.once('unexpected-response', () => resolve('error'));
      });
      expect(noTokenResult).toBe('error');

      const wrongTokenWs = new WebSocket(wsUrl(port, 'b'.repeat(32)), { headers: { Origin: TEST_ORIGIN } });
      const wrongTokenResult = await new Promise<'open' | 'error'>((resolve) => {
        wrongTokenWs.once('open', () => resolve('open'));
        wrongTokenWs.once('error', () => resolve('error'));
        wrongTokenWs.once('unexpected-response', () => resolve('error'));
      });
      expect(wrongTokenResult).toBe('error');

      // Sanity check: the right token still gets a hello.
      const { ws, reader } = await openSocket(port);
      const hello = await reader.next();
      expect(hello.type).toBe('hello');
      ws.close();
    } finally {
      await server.stop();
    }
  });

  it('enforces a single server-wide run lock across connections', async () => {
    const cwd = process.cwd();
    const releaseRunHolder: { current: (() => void) | null } = { current: null };
    class SlowRunner implements AgentRunner {
      readonly kind = 'claude' as const;
      isAvailable(): Promise<boolean> {
        return Promise.resolve(true);
      }
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: 'started', agent: 'claude' };
        await new Promise<void>((resolve) => {
          releaseRunHolder.current = resolve;
        });
        yield { type: 'done', exitCode: 0 };
      }
    }

    const server = createServer({
      port: 0,
      cwd,
      runners: [new SlowRunner()],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const port = server.port;
      const { ws: wsA, reader: readerA } = await openSocket(port);
      await readerA.next(); // hello
      const { ws: wsB, reader: readerB } = await openSocket(port);
      await readerB.next(); // hello

      wsA.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'p1', element }));
      expect(await readerA.next()).toEqual({ type: 'event', event: { type: 'started', agent: 'claude' } });

      // Second connection's run is refused while A's run is in flight.
      wsB.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'p2', element }));
      expect(await readerB.next()).toEqual({ type: 'error', message: 'Un run est déjà en cours.' });

      releaseRunHolder.current?.();
      expect(await readerA.next()).toEqual({ type: 'event', event: { type: 'done', exitCode: 0 } });
      expect((await readerA.next()).type).toBe('diff');

      wsA.close();
      wsB.close();
    } finally {
      await server.stop();
    }
  });
});

class FileWritingRunner implements AgentRunner {
  readonly kind = 'claude' as const;
  constructor(private readonly cwd: string) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async *run(): AsyncIterable<AgentEvent> {
    yield { type: 'started', agent: 'claude' };
    await fs.writeFile(path.join(this.cwd, 'touched.txt'), 'agent wrote this\n');
    yield { type: 'done', exitCode: 0 };
  }
}

describe('server diff / accept / reject', () => {
  it('sends a diff after a run and restores touched files on reject', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'vizion-server-test-'));
    await execFileAsync('git', ['init', '-q'], { cwd });
    await execFileAsync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-q', '-m', 'init'],
      { cwd },
    );

    const server = createServer({
      port: 0,
      cwd,
      runners: [new FileWritingRunner(cwd)],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const port = server.port;
      const { ws, reader } = await openSocket(port);
      await reader.next(); // hello

      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'do it', element }));

      const events: ServerMessage[] = [];
      while (events.length < 3) {
        events.push(await reader.next());
      }
      expect(events[0]).toEqual({ type: 'event', event: { type: 'started', agent: 'claude' } });
      expect(events[1]).toEqual({ type: 'event', event: { type: 'done', exitCode: 0 } });
      const diffMessage = events[2];
      if (diffMessage?.type !== 'diff') throw new Error('expected diff message');
      expect(diffMessage.files).toHaveLength(1);
      expect(diffMessage.files[0]).toMatchObject({ path: 'touched.txt', status: 'added' });

      ws.send(JSON.stringify({ type: 'reject' }));
      const restoredMessage = await reader.next();
      expect(restoredMessage).toEqual({ type: 'restored', files: ['touched.txt'] });
      const afterReject = await reader.next();
      expect(afterReject).toEqual({ type: 'diff', files: [] });
      await expect(fs.readFile(path.join(cwd, 'touched.txt'))).rejects.toThrow();

      ws.send(JSON.stringify({ type: 'reject' }));
      const secondReject = await reader.next();
      expect(secondReject).toEqual({ type: 'error', message: 'rien à accepter ou rejeter' });

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
