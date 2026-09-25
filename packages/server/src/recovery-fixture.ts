import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentEvent, AgentRunner, ClientMessage, ServerMessage } from '@vizion/shared';
import { WebSocket } from 'ws';
import { createServer } from './server.js';

const exec = promisify(execFile);
const token = 'recovery-test-token';
export const runMessage = {
  type: 'run', agent: 'claude', prompt: 'change it',
  element: {
    selector: '#button', tagName: 'button', classes: [], textContent: 'Go',
    outerHtml: '<button>Go</button>', domPath: ['html', 'button'],
    rect: { x: 0, y: 0, width: 1, height: 1 }, computedStyles: {}, pageUrl: 'https://example.com',
  },
} satisfies ClientMessage;

export function signal() {
  let resolve: () => void = () => { throw new Error('signal not initialized'); };
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function fixture(action: (cwd: string, abort: AbortSignal) => Promise<void>) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'vizion-recovery-'));
  await exec('git', ['init', '-q'], { cwd });
  await fs.writeFile(path.join(cwd, 'tracked.txt'), 'original\n');
  await exec('git', ['add', '.'], { cwd });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init'], { cwd });
  const runner: AgentRunner = {
    kind: 'claude', isAvailable: async () => true,
    async *run(_request, abort): AsyncIterable<AgentEvent> {
      yield { type: 'started', agent: 'claude' };
      await action(cwd, abort);
      yield { type: 'done', exitCode: 0 };
    },
  };
  const server = createServer({ port: 0, cwd, runners: [runner], token, allowedOriginPrefixes: ['http://test'] });
  const sockets: WebSocket[] = [];
  await server.start();
  return {
    cwd,
    async connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${token}`, { origin: 'http://test' });
      sockets.push(ws);
      const messages: ServerMessage[] = [];
      let notify: (() => void) | undefined;
      ws.on('message', (data: Buffer) => {
        const message: ServerMessage = JSON.parse(data.toString());
        messages.push(message);
        notify?.();
      });
      await once(ws, 'open');
      const client = {
        ws,
        send(message: ClientMessage | { readonly type: 'accept' | 'reject'; readonly runId?: string }) {
          ws.send(JSON.stringify(message));
        },
        async next(): Promise<ServerMessage> {
          if (messages.length === 0) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('message timeout')), 3000);
              notify = () => { clearTimeout(timer); notify = undefined; resolve(); };
            });
          }
          const message = messages.shift();
          if (!message) throw new Error('expected message');
          return message;
        },
        async outcome() {
          for (;;) {
            const message = await client.next();
            switch (message.type) {
              case 'event': continue;
              default: return message;
            }
          }
        },
        async close() {
          const closed = once(ws, 'close');
          ws.close();
          await closed;
        },
      };
      await client.next(); // hello
      await client.next(); // history
      return client;
    },
    async [Symbol.asyncDispose]() {
      for (const ws of sockets) ws.terminate();
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    },
  };
}

export type RecoveryClient = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['connect']>>;

export async function startRun(client: RecoveryClient) {
  client.send(runMessage);
  const message = await client.outcome();
  if (message.type !== 'diff') throw new Error(`expected diff: ${JSON.stringify(message)}`);
  return message;
}

export async function writeChange(cwd: string) {
  await fs.writeFile(path.join(cwd, 'tracked.txt'), 'agent\n');
}
