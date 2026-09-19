import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AgentEvent, AgentKind, AgentRunner, ServerMessage } from '@vizion/shared';
import { createServer, OpLock } from './server.js';

const IS_WIN32 = process.platform === 'win32';

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

describe('OpLock', () => {
  it('allows only one operation at a time and releases it', () => {
    const lock = new OpLock();
    expect(lock.active).toBeNull();
    expect(lock.acquire('run')).toBe(true);
    expect(lock.active).toBe('run');
    expect(lock.acquire('undo')).toBe(false);
    expect(lock.acquire('run')).toBe(false);
    lock.release('run');
    expect(lock.active).toBeNull();

    expect(lock.acquire('undo')).toBe(true);
    expect(lock.acquire('run')).toBe(false);
    lock.release('undo');
    expect(lock.active).toBeNull();
  });

  it('release is a no-op when it does not name the currently held operation', () => {
    const lock = new OpLock();
    lock.acquire('run');
    lock.release('undo');
    expect(lock.active).toBe('run');
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
      expect(await reader.next()).toEqual({ type: 'history', runs: [] });

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
      const acceptedHistory = await reader.next();
      if (acceptedHistory.type !== 'history') throw new Error('expected history message');
      expect(acceptedHistory.runs).toHaveLength(1);
      expect(acceptedHistory.runs[0]).toMatchObject({
        agent: 'claude',
        prompt: 'make it blue',
        status: 'accepted',
        files: [],
      });

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
      await readerA.next(); // history
      const { ws: wsB, reader: readerB } = await openSocket(port);
      await readerB.next(); // hello
      await readerB.next(); // history

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
      await reader.next(); // history

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
      expect(await reader.next()).toEqual({ type: 'history', runs: [] });
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

class MultiFileRunner implements AgentRunner {
  readonly kind = 'claude' as const;
  constructor(private readonly cwd: string) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async *run(): AsyncIterable<AgentEvent> {
    yield { type: 'started', agent: 'claude' };
    await fs.writeFile(path.join(this.cwd, 'new.txt'), 'brand new\n');
    await fs.writeFile(path.join(this.cwd, 'tracked.txt'), 'changed content\n');
    yield { type: 'done', exitCode: 0 };
  }
}

class DeletingRunner implements AgentRunner {
  readonly kind = 'claude' as const;
  constructor(private readonly cwd: string) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async *run(): AsyncIterable<AgentEvent> {
    yield { type: 'started', agent: 'claude' };
    await fs.rm(path.join(this.cwd, 'tracked.txt'));
    yield { type: 'done', exitCode: 0 };
  }
}

async function setupGitRepo(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'vizion-server-history-test-'));
  await execFileAsync('git', ['init', '-q'], { cwd });
  await fs.writeFile(path.join(cwd, 'tracked.txt'), 'original content\n');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd });
  await execFileAsync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'],
    { cwd },
  );
  return cwd;
}

describe('server run history / undo', () => {
  it('records an accepted run in history and undoes it, restoring both files', async () => {
    const cwd = await setupGitRepo();
    const server = createServer({
      port: 0,
      cwd,
      runners: [new MultiFileRunner(cwd)],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const port = server.port;
      const { ws, reader } = await openSocket(port);
      expect((await reader.next()).type).toBe('hello');
      expect(await reader.next()).toEqual({ type: 'history', runs: [] });

      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'do multi', element }));
      const events: ServerMessage[] = [];
      while (events.length < 3) {
        events.push(await reader.next());
      }
      const diffMessage = events[2];
      if (diffMessage?.type !== 'diff') throw new Error('expected diff message');
      expect(diffMessage.files.map((f) => f.path).sort()).toEqual(['new.txt', 'tracked.txt']);

      ws.send(JSON.stringify({ type: 'accept' }));
      expect(await reader.next()).toEqual({ type: 'diff', files: [] });
      const historyAfterAccept = await reader.next();
      if (historyAfterAccept.type !== 'history') throw new Error('expected history message');
      expect(historyAfterAccept.runs).toHaveLength(1);
      const record = historyAfterAccept.runs[0];
      if (!record) throw new Error('expected a run record');
      expect(record).toMatchObject({ agent: 'claude', prompt: 'do multi', status: 'accepted' });
      expect(record.files.slice().sort()).toEqual(['new.txt', 'tracked.txt']);

      // Explicit list-history request returns the same thing.
      ws.send(JSON.stringify({ type: 'list-history' }));
      expect(await reader.next()).toEqual({ type: 'history', runs: [record] });

      ws.send(JSON.stringify({ type: 'undo-run', id: record.id }));
      const undone = await reader.next();
      if (undone.type !== 'run-undone') throw new Error('expected run-undone message');
      expect(undone.id).toBe(record.id);
      expect(undone.files.slice().sort()).toEqual(['new.txt', 'tracked.txt']);
      const historyAfterUndo = await reader.next();
      if (historyAfterUndo.type !== 'history') throw new Error('expected history message');
      expect(historyAfterUndo.runs[0]).toMatchObject({ id: record.id, status: 'undone' });

      // The new file is gone, and the tracked file is back to its original content.
      await expect(fs.readFile(path.join(cwd, 'new.txt'))).rejects.toThrow();
      expect(await fs.readFile(path.join(cwd, 'tracked.txt'), 'utf8')).toBe('original content\n');

      // Undoing the same run again is refused.
      ws.send(JSON.stringify({ type: 'undo-run', id: record.id }));
      const secondUndo = await reader.next();
      expect(secondUndo).toEqual({ type: 'error', message: 'Ce run a déjà été annulé.' });

      // Undoing an unknown id is refused.
      ws.send(JSON.stringify({ type: 'undo-run', id: 'does-not-exist' }));
      expect(await reader.next()).toEqual({ type: 'error', message: 'Run introuvable.' });

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('undoes a run that deleted a tracked file, recreating it with its original content', async () => {
    const cwd = await setupGitRepo();
    const server = createServer({
      port: 0,
      cwd,
      runners: [new DeletingRunner(cwd)],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const port = server.port;
      const { ws, reader } = await openSocket(port);
      await reader.next(); // hello
      await reader.next(); // history

      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'delete it', element }));
      const events: ServerMessage[] = [];
      while (events.length < 3) events.push(await reader.next());
      const diffMessage = events[2];
      if (diffMessage?.type !== 'diff') throw new Error('expected diff message');
      expect(diffMessage.files).toEqual([expect.objectContaining({ path: 'tracked.txt', status: 'deleted' })]);

      ws.send(JSON.stringify({ type: 'accept' }));
      await reader.next(); // diff []
      const historyMsg = await reader.next();
      if (historyMsg.type !== 'history') throw new Error('expected history');
      const record = historyMsg.runs[0];
      if (!record) throw new Error('expected a record');

      ws.send(JSON.stringify({ type: 'undo-run', id: record.id }));
      const undone = await reader.next();
      if (undone.type !== 'run-undone') throw new Error('expected run-undone message');
      expect(undone.files).toEqual(['tracked.txt']);
      await reader.next(); // history

      expect(await fs.readFile(path.join(cwd, 'tracked.txt'), 'utf8')).toBe('original content\n');

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('refuses undo while a diff is pending', async () => {
    const cwd = await setupGitRepo();
    const server = createServer({
      port: 0,
      cwd,
      runners: [new MultiFileRunner(cwd)],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const port = server.port;
      const { ws, reader } = await openSocket(port);
      expect((await reader.next()).type).toBe('hello');
      expect((await reader.next()).type).toBe('history');

      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'do multi', element }));
      const events: ServerMessage[] = [];
      while (events.length < 3) {
        events.push(await reader.next());
      }
      expect(events[2]?.type).toBe('diff'); // pending, not yet accepted or rejected

      ws.send(JSON.stringify({ type: 'undo-run', id: 'whatever' }));
      expect(await reader.next()).toEqual({
        type: 'error',
        message: "Termine le run en cours d'abord.",
      });

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  function makeFileRunner(kind: AgentKind, targetCwd: string, filename: string): AgentRunner {
    return {
      kind,
      isAvailable: () => Promise.resolve(true),
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: 'started', agent: kind };
        await fs.writeFile(path.join(targetCwd, filename), `${filename} content\n`);
        yield { type: 'done', exitCode: 0 };
      },
    };
  }

  it('only allows undoing the most recent still-accepted run', async () => {
    const cwd = await setupGitRepo();
    const server = createServer({
      port: 0,
      cwd,
      runners: [makeFileRunner('claude', cwd, 'a.txt'), makeFileRunner('codex', cwd, 'b.txt')],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const port = server.port;
      const { ws, reader } = await openSocket(port);
      await reader.next(); // hello
      await reader.next(); // history

      async function runAndAccept(agent: AgentKind, prompt: string) {
        ws.send(JSON.stringify({ type: 'run', agent, prompt, element }));
        const evts: ServerMessage[] = [];
        while (evts.length < 3) evts.push(await reader.next());
        ws.send(JSON.stringify({ type: 'accept' }));
        await reader.next(); // diff []
        const historyMsg = await reader.next();
        if (historyMsg.type !== 'history') throw new Error('expected history');
        const rec = historyMsg.runs[0];
        if (!rec) throw new Error('expected a record');
        return rec;
      }

      const first = await runAndAccept('claude', 'first');
      const second = await runAndAccept('codex', 'second');
      expect(second.files).toEqual(['b.txt']);

      // Trying to undo the older run first is refused.
      ws.send(JSON.stringify({ type: 'undo-run', id: first.id }));
      expect(await reader.next()).toEqual({
        type: 'error',
        message: "Annule d'abord les runs plus récents.",
      });

      // Undoing the most recent one works.
      ws.send(JSON.stringify({ type: 'undo-run', id: second.id }));
      const undone = await reader.next();
      if (undone.type !== 'run-undone') throw new Error('expected run-undone message');
      expect(undone.id).toBe(second.id);
      await expect(fs.readFile(path.join(cwd, 'b.txt'))).rejects.toThrow();
      await reader.next(); // history

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

const ORIGINAL_BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a]);
const MODIFIED_BINARY = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe]);
const NEW_BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]);

async function setupGitRepoWithBinary(): Promise<string> {
  const cwd = await setupGitRepo();
  await fs.writeFile(path.join(cwd, 'image.bin'), ORIGINAL_BINARY);
  await execFileAsync('git', ['add', 'image.bin'], { cwd });
  await execFileAsync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'binary'],
    { cwd },
  );
  return cwd;
}

class BinaryRunner implements AgentRunner {
  readonly kind = 'claude' as const;
  constructor(private readonly cwd: string) {}
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }
  async *run(): AsyncIterable<AgentEvent> {
    yield { type: 'started', agent: 'claude' };
    await fs.writeFile(path.join(this.cwd, 'new.bin'), NEW_BINARY);
    await fs.writeFile(path.join(this.cwd, 'image.bin'), MODIFIED_BINARY);
    yield { type: 'done', exitCode: 0 };
  }
}

class EmptyFileRunner implements AgentRunner {
  readonly kind = 'claude' as const;
  constructor(private readonly cwd: string) {}
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }
  async *run(): AsyncIterable<AgentEvent> {
    yield { type: 'started', agent: 'claude' };
    await fs.writeFile(path.join(this.cwd, 'empty.txt'), '');
    yield { type: 'done', exitCode: 0 };
  }
}

async function setupGitRepoWithScript(): Promise<string> {
  const cwd = await setupGitRepo();
  const file = path.join(cwd, 'script.sh');
  await fs.writeFile(file, '#!/bin/sh\necho original\n');
  await fs.chmod(file, 0o644);
  await execFileAsync('git', ['add', 'script.sh'], { cwd });
  await execFileAsync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'script'],
    { cwd },
  );
  return cwd;
}

class ChmodRunner implements AgentRunner {
  readonly kind = 'claude' as const;
  constructor(private readonly cwd: string) {}
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }
  async *run(): AsyncIterable<AgentEvent> {
    yield { type: 'started', agent: 'claude' };
    const file = path.join(this.cwd, 'script.sh');
    await fs.writeFile(file, '#!/bin/sh\necho changed\n');
    await fs.chmod(file, 0o755);
    yield { type: 'done', exitCode: 0 };
  }
}

/** Drains messages from `reader` until a `run-undone` or `error` arrives. */
async function readUndoOutcome(
  reader: ReturnType<typeof createMessageReader>,
): Promise<ServerMessage> {
  for (;;) {
    const message = await reader.next();
    if (message.type === 'run-undone' || message.type === 'error') return message;
  }
}

describe('server undo-run: byte-based restore', () => {
  it('undoes a run touching binary files, restoring exact bytes and deleting the new one', async () => {
    const cwd = await setupGitRepoWithBinary();
    const server = createServer({
      port: 0,
      cwd,
      runners: [new BinaryRunner(cwd)],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const port = server.port;
      const { ws, reader } = await openSocket(port);
      await reader.next(); // hello
      await reader.next(); // history

      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'binary', element }));
      const events: ServerMessage[] = [];
      while (events.length < 3) events.push(await reader.next());
      const diffMessage = events[2];
      if (diffMessage?.type !== 'diff') throw new Error('expected diff message');
      expect(diffMessage.files.map((f) => f.path).sort()).toEqual(['image.bin', 'new.bin']);

      ws.send(JSON.stringify({ type: 'accept' }));
      await reader.next(); // diff []
      const historyMsg = await reader.next();
      if (historyMsg.type !== 'history') throw new Error('expected history');
      const record = historyMsg.runs[0];
      if (!record) throw new Error('expected a record');

      ws.send(JSON.stringify({ type: 'undo-run', id: record.id }));
      const undone = await readUndoOutcome(reader);
      if (undone.type !== 'run-undone') throw new Error(`expected run-undone, got ${JSON.stringify(undone)}`);

      expect(await fs.readFile(path.join(cwd, 'image.bin'))).toEqual(ORIGINAL_BINARY);
      await expect(fs.readFile(path.join(cwd, 'new.bin'))).rejects.toThrow();

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('undoes a run that added an empty file by deleting it', async () => {
    const cwd = await setupGitRepo();
    const server = createServer({
      port: 0,
      cwd,
      runners: [new EmptyFileRunner(cwd)],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const port = server.port;
      const { ws, reader } = await openSocket(port);
      await reader.next(); // hello
      await reader.next(); // history

      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'empty', element }));
      const events: ServerMessage[] = [];
      while (events.length < 3) events.push(await reader.next());
      const diffMessage = events[2];
      if (diffMessage?.type !== 'diff') throw new Error('expected diff message');
      expect(diffMessage.files).toEqual([expect.objectContaining({ path: 'empty.txt', status: 'added' })]);

      ws.send(JSON.stringify({ type: 'accept' }));
      await reader.next(); // diff []
      const historyMsg = await reader.next();
      if (historyMsg.type !== 'history') throw new Error('expected history');
      const record = historyMsg.runs[0];
      if (!record) throw new Error('expected a record');

      ws.send(JSON.stringify({ type: 'undo-run', id: record.id }));
      const undone = await readUndoOutcome(reader);
      if (undone.type !== 'run-undone') throw new Error(`expected run-undone, got ${JSON.stringify(undone)}`);

      await expect(fs.readFile(path.join(cwd, 'empty.txt'))).rejects.toThrow();

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it.skipIf(IS_WIN32)('undoes a run that changed both content and mode, restoring both', async () => {
    const cwd = await setupGitRepoWithScript();
    const server = createServer({
      port: 0,
      cwd,
      runners: [new ChmodRunner(cwd)],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const port = server.port;
      const { ws, reader } = await openSocket(port);
      await reader.next(); // hello
      await reader.next(); // history

      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'chmod', element }));
      const events: ServerMessage[] = [];
      while (events.length < 3) events.push(await reader.next());
      const diffMessage = events[2];
      if (diffMessage?.type !== 'diff') throw new Error('expected diff message');
      expect(diffMessage.files).toEqual([expect.objectContaining({ path: 'script.sh', status: 'modified' })]);

      ws.send(JSON.stringify({ type: 'accept' }));
      await reader.next(); // diff []
      const historyMsg = await reader.next();
      if (historyMsg.type !== 'history') throw new Error('expected history');
      const record = historyMsg.runs[0];
      if (!record) throw new Error('expected a record');

      ws.send(JSON.stringify({ type: 'undo-run', id: record.id }));
      const undone = await readUndoOutcome(reader);
      if (undone.type !== 'run-undone') throw new Error(`expected run-undone, got ${JSON.stringify(undone)}`);

      const scriptPath = path.join(cwd, 'script.sh');
      expect(await fs.readFile(scriptPath, 'utf8')).toBe('#!/bin/sh\necho original\n');
      const stat = await fs.stat(scriptPath);
      expect(stat.mode & 0o777).toBe(0o644);

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('refuses undo and leaves the file untouched when it was recreated after the run deleted it', async () => {
    const cwd = await setupGitRepo();
    const server = createServer({
      port: 0,
      cwd,
      runners: [new DeletingRunner(cwd)],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const port = server.port;
      const { ws, reader } = await openSocket(port);
      await reader.next(); // hello
      await reader.next(); // history

      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'delete it', element }));
      const events: ServerMessage[] = [];
      while (events.length < 3) events.push(await reader.next());
      const diffMessage = events[2];
      if (diffMessage?.type !== 'diff') throw new Error('expected diff message');
      expect(diffMessage.files).toEqual([expect.objectContaining({ path: 'tracked.txt', status: 'deleted' })]);

      ws.send(JSON.stringify({ type: 'accept' }));
      await reader.next(); // diff []
      const historyMsg = await reader.next();
      if (historyMsg.type !== 'history') throw new Error('expected history');
      const record = historyMsg.runs[0];
      if (!record) throw new Error('expected a record');

      // The user recreates the file at the same path with new content.
      await fs.writeFile(path.join(cwd, 'tracked.txt'), 'user recreated this\n');

      ws.send(JSON.stringify({ type: 'undo-run', id: record.id }));
      const result = await readUndoOutcome(reader);
      if (result.type !== 'error') throw new Error(`expected error, got ${JSON.stringify(result)}`);
      expect(result.message).toContain('Conflit');
      expect(await fs.readFile(path.join(cwd, 'tracked.txt'), 'utf8')).toBe('user recreated this\n');

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('server: multi-client broadcast and ordering', () => {
  it('broadcasts history to every client after accept, and refuses a run from another client while a diff is pending', async () => {
    const cwd = await setupGitRepo();
    const server = createServer({
      port: 0,
      cwd,
      runners: [new MultiFileRunner(cwd)],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const port = server.port;
      const { ws: wsA, reader: readerA } = await openSocket(port);
      await readerA.next(); // hello
      await readerA.next(); // history
      const { ws: wsB, reader: readerB } = await openSocket(port);
      await readerB.next(); // hello
      await readerB.next(); // history

      wsA.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'do multi', element }));
      const events: ServerMessage[] = [];
      while (events.length < 3) events.push(await readerA.next());
      expect(events[2]?.type).toBe('diff'); // A now has a pending, undecided diff

      // B's run is refused: a pending diff exists project-wide, not just on A's socket.
      wsB.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'p2', element }));
      expect(await readerB.next()).toEqual({
        type: 'error',
        message: "Accepte ou rejette d'abord les modifications en attente.",
      });

      wsA.send(JSON.stringify({ type: 'accept' }));
      expect(await readerA.next()).toEqual({ type: 'diff', files: [] });
      const historyA = await readerA.next();
      if (historyA.type !== 'history') throw new Error('expected history');
      expect(historyA.runs).toHaveLength(1);

      // B, which never accepted or rejected anything itself, still sees the broadcast.
      const historyB = await readerB.next();
      if (historyB.type !== 'history') throw new Error('expected history');
      expect(historyB.runs).toHaveLength(1);
      expect(historyB.runs[0]).toMatchObject({ status: 'accepted', prompt: 'do multi' });

      wsA.close();
      wsB.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

class OverlayRunner implements AgentRunner {
  readonly kind = 'claude' as const;
  seenCwd: string | null = null;
  constructor(private readonly text: string) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async *run(req: { cwd: string }): AsyncIterable<AgentEvent> {
    this.seenCwd = req.cwd;
    yield { type: 'started', agent: 'claude' };
    yield { type: 'text', text: this.text };
    yield { type: 'done', exitCode: 0 };
  }
}

describe('server overlay mode', () => {
  it('runs in a fresh temp dir, sends overlay-proposal (no diff), and removes the temp dir after', async () => {
    const projectCwd = await setupGitRepo();
    const runner = new OverlayRunner(
      [
        'Making it blue.',
        '```json',
        '[{ "selector": "#btn", "kind": "style", "property": "color", "value": "blue" }]',
        '```',
      ].join('\n'),
    );
    const server = createServer({
      port: 0,
      cwd: projectCwd,
      runners: [runner],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const { ws, reader } = await openSocket(server.port);
      await reader.next(); // hello
      await reader.next(); // history

      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'make it blue', element, mode: 'overlay' }));

      const received: ServerMessage[] = [];
      while (received.length < 4) {
        received.push(await reader.next());
      }
      expect(received[0]).toEqual({ type: 'event', event: { type: 'started', agent: 'claude' } });
      expect(received[3]).toEqual({
        type: 'overlay-proposal',
        overrides: [{ selector: '#btn', kind: 'style', property: 'color', value: 'blue' }],
        note: 'Making it blue.',
      });
      expect(received.some((message) => message.type === 'diff')).toBe(false);

      expect(runner.seenCwd).not.toBeNull();
      expect(runner.seenCwd).not.toBe(projectCwd);
      await expect(fs.stat(runner.seenCwd as string)).rejects.toThrow();

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(projectCwd, { recursive: true, force: true });
    }
  });

  it('sends an error when the agent replies with prose only', async () => {
    const projectCwd = await setupGitRepo();
    const runner = new OverlayRunner('Sorry, I cannot help with that.');
    const server = createServer({
      port: 0,
      cwd: projectCwd,
      runners: [runner],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const { ws, reader } = await openSocket(server.port);
      await reader.next(); // hello
      await reader.next(); // history

      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'make it blue', element, mode: 'overlay' }));

      const received: ServerMessage[] = [];
      while (received.length < 4) {
        received.push(await reader.next());
      }
      expect(received[3]).toEqual({
        type: 'error',
        message: "L'agent n'a pas renvoyé de proposition exploitable.",
      });

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(projectCwd, { recursive: true, force: true });
    }
  });
});
