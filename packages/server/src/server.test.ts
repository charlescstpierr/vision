import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AgentEvent, AgentRunner, ServerMessage } from '@vizion/shared';
import { createServer } from './server.js';

describe('server', () => {
  it('serves /health with the expected shape', async () => {
    const cwd = process.cwd();
    const server = createServer({ port: 0, cwd, runners: [] });
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
      };
      expect(body.name).toBe('vizion');
      expect(typeof body.version).toBe('string');
      expect(body.cwd).toBe(cwd);
      expect(Array.isArray(body.agents)).toBe(true);
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

describe('server websocket', () => {
  it('streams agent events over /ws, rejects concurrent runs, and rejects bad origins', async () => {
    const cwd = process.cwd();
    const server = createServer({
      port: 0,
      cwd,
      runners: [new FakeRunner()],
      allowedOriginPrefixes: ['http://test'],
    });
    await server.start();

    try {
      const port = server.port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'http://test' } });
      const reader = createMessageReader(ws);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });

      const hello = await reader.next();
      expect(hello).toEqual({
        type: 'hello',
        version: expect.any(String),
        cwd,
        agents: ['claude'],
      });

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

      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'make it blue', element }));

      const received: ServerMessage[] = [];
      while (received.length < 4) {
        received.push(await reader.next());
      }
      expect(received).toEqual([
        { type: 'event', event: { type: 'started', agent: 'claude' } },
        { type: 'event', event: { type: 'text', text: 'hello' } },
        { type: 'event', event: { type: 'text', text: 'world' } },
        { type: 'event', event: { type: 'done', exitCode: 0 } },
      ]);

      // Sending a second `run` before the first has finished must be
      // rejected with an error (the run slot is reserved synchronously).
      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'p1', element }));
      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'p2', element }));
      const results: ServerMessage[] = [];
      // Drain remaining messages for this exchange (4 events + 1 error, in some order).
      while (results.length < 5) {
        results.push(await reader.next());
      }
      const errorMessages = results.filter((m) => m.type === 'error');
      expect(errorMessages).toEqual([
        { type: 'error', message: 'a run is already active on this connection' },
      ]);

      ws.close();

      // Bad origin: the upgrade must fail.
      const badWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
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
});
