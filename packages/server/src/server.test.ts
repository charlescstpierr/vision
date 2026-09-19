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

      // Nothing to approve: a finished run leaves no gate, so the next run
      // goes straight through.
      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'p1', element }));
      expect(await reader.next()).toEqual({ type: 'event', event: { type: 'started', agent: 'claude' } });
      const second: ServerMessage[] = [];
      while (second.length < 4) second.push(await reader.next());
      expect(second[3]).toEqual({ type: 'diff', files: [] });

      // A run that touched nothing is not worth a history entry either.
      ws.send(JSON.stringify({ type: 'list-history' }));
      expect(await reader.next()).toEqual({ type: 'history', runs: [] });

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

describe('server diff', () => {
  it('sends a diff after a run, records it, and takes it back on undo', async () => {
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

      // The run is already applied, so it lands in the history with no
      // approval step in between.
      const history = await reader.next();
      if (history.type !== 'history') throw new Error('expected history');
      expect(history.runs).toHaveLength(1);
      expect(history.runs[0]).toMatchObject({ status: 'applied', files: ['touched.txt'] });

      ws.send(JSON.stringify({ type: 'undo-run', id: history.runs[0]!.id }));
      expect(await reader.next()).toEqual({
        type: 'run-undone',
        id: history.runs[0]!.id,
        files: ['touched.txt'],
      });
      expect((await reader.next()).type).toBe('history');
      await expect(fs.readFile(path.join(cwd, 'touched.txt'))).rejects.toThrow();

      ws.send(JSON.stringify({ type: 'undo-run', id: history.runs[0]!.id }));
      expect(await reader.next()).toEqual({ type: 'error', message: 'Ce run a déjà été annulé.' });

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

      const historyAfterAccept = await reader.next();
      if (historyAfterAccept.type !== 'history') throw new Error('expected history message');
      expect(historyAfterAccept.runs).toHaveLength(1);
      const record = historyAfterAccept.runs[0];
      if (!record) throw new Error('expected a run record');
      expect(record).toMatchObject({ agent: 'claude', prompt: 'do multi', status: 'applied' });
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

  it('refuses undo while a run is still in flight', async () => {
    const cwd = await setupGitRepo();
    const server = createServer({
      port: 0,
      cwd,
      runners: [new HangingRunner()],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const port = server.port;
      const { ws, reader } = await openSocket(port);
      expect((await reader.next()).type).toBe('hello');
      expect((await reader.next()).type).toBe('history');

      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'hangs', element }));
      expect(await reader.next()).toEqual({ type: 'event', event: { type: 'started', agent: 'claude' } });

      ws.send(JSON.stringify({ type: 'undo-run', id: 'whatever' }));
      expect(await reader.next()).toEqual({
        type: 'error',
        message: "Termine le run en cours d'abord.",
      });

      ws.send(JSON.stringify({ type: 'cancel' }));
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

  it('only allows undoing the most recent still-applied run', async () => {
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
    if (message.type === 'run-undone' || message.type === 'error' || message.type === 'undo-conflict') {
      return message;
    }
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

  it('reports a conflict, changes nothing, and reverts anyway on force', async () => {
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

      const historyMsg = await reader.next();
      if (historyMsg.type !== 'history') throw new Error('expected history');
      const record = historyMsg.runs[0];
      if (!record) throw new Error('expected a record');

      // The user recreates the file at the same path with new content.
      await fs.writeFile(path.join(cwd, 'tracked.txt'), 'user recreated this\n');

      ws.send(JSON.stringify({ type: 'undo-run', id: record.id }));
      const result = await readUndoOutcome(reader);
      if (result.type !== 'undo-conflict') throw new Error(`expected undo-conflict, got ${JSON.stringify(result)}`);
      expect(result).toEqual({ type: 'undo-conflict', id: record.id, files: ['tracked.txt'] });
      // Nothing written: the refusal leaves the tree exactly as it was.
      expect(await fs.readFile(path.join(cwd, 'tracked.txt'), 'utf8')).toBe('user recreated this\n');

      // Forcing it through is the user's call, and it discards what changed.
      ws.send(JSON.stringify({ type: 'undo-run', id: record.id, force: true }));
      const forced = await readUndoOutcome(reader);
      if (forced.type !== 'run-undone') throw new Error(`expected run-undone, got ${JSON.stringify(forced)}`);
      expect(await fs.readFile(path.join(cwd, 'tracked.txt'), 'utf8')).toBe('original content\n');

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('server: multi-client broadcast and ordering', () => {
  it('broadcasts the diff and the refreshed history to every client, with no approval in between', async () => {
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
      expect(events[2]?.type).toBe('diff');

      const historyA = await readerA.next();
      if (historyA.type !== 'history') throw new Error('expected history');
      expect(historyA.runs).toHaveLength(1);

      // The run belongs to the project, so B is shown the same diff and the
      // same history without having asked for anything.
      const diffForB = await readerB.next();
      if (diffForB.type !== 'diff') throw new Error('expected diff');
      expect(diffForB.files.length).toBeGreaterThan(0);
      const historyB = await readerB.next();
      if (historyB.type !== 'history') throw new Error('expected history');
      expect(historyB.runs).toHaveLength(1);
      expect(historyB.runs[0]).toMatchObject({ status: 'applied', prompt: 'do multi' });

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

// A 1x1 transparent PNG, same fixture as screenshot.test.ts.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

class ScreenshotCapturingRunner implements AgentRunner {
  readonly kind = 'claude' as const;
  invoked = false;
  capturedScreenshotPath: string | undefined;
  existedDuringRun = false;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async *run(req: { cwd: string; screenshotPath?: string }): AsyncIterable<AgentEvent> {
    this.invoked = true;
    this.capturedScreenshotPath = req.screenshotPath;
    if (req.screenshotPath) {
      this.existedDuringRun = await fs
        .access(req.screenshotPath)
        .then(() => true)
        .catch(() => false);
    }
    yield { type: 'started', agent: 'claude' };
    yield { type: 'done', exitCode: 0 };
  }
}

describe('server screenshot handling', () => {
  it('writes a temp file for a valid screenshot, passes its path to the runner, and removes it after the run', async () => {
    const cwd = await setupGitRepo();
    const runner = new ScreenshotCapturingRunner();
    const server = createServer({
      port: 0,
      cwd,
      runners: [runner],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const { ws, reader } = await openSocket(server.port);
      await reader.next(); // hello
      await reader.next(); // history

      ws.send(
        JSON.stringify({
          type: 'run',
          agent: 'claude',
          prompt: 'do it',
          element,
          screenshot: { dataUrl: `data:image/png;base64,${PNG_1X1_BASE64}`, width: 1, height: 1 },
        }),
      );

      const events: ServerMessage[] = [];
      while (events.length < 3) {
        events.push(await reader.next());
      }
      expect(events[0]).toEqual({ type: 'event', event: { type: 'started', agent: 'claude' } });
      expect(events[1]).toEqual({ type: 'event', event: { type: 'done', exitCode: 0 } });
      expect(events[2]?.type).toBe('diff');

      expect(runner.invoked).toBe(true);
      expect(runner.capturedScreenshotPath).toBeTypeOf('string');
      expect(runner.existedDuringRun).toBe(true);
      await expect(fs.access(runner.capturedScreenshotPath as string)).rejects.toThrow();

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported image type without invoking the runner', async () => {
    const cwd = await setupGitRepo();
    const runner = new ScreenshotCapturingRunner();
    const server = createServer({
      port: 0,
      cwd,
      runners: [runner],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const { ws, reader } = await openSocket(server.port);
      await reader.next(); // hello
      await reader.next(); // history

      ws.send(
        JSON.stringify({
          type: 'run',
          agent: 'claude',
          prompt: 'do it',
          element,
          screenshot: { dataUrl: `data:image/gif;base64,${PNG_1X1_BASE64}`, width: 1, height: 1 },
        }),
      );

      expect(await reader.next()).toEqual({ type: 'error', message: 'Capture invalide.' });
      expect(runner.invoked).toBe(false);

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * Yields `started`, then blocks until the run's `AbortSignal` fires. Stands in
 * for an agent that hangs (or simply takes longer than the user is willing to
 * wait), so `cancel` and the run timeout can be exercised.
 */
class HangingRunner implements AgentRunner {
  readonly kind = 'claude' as const;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async *run(_req: unknown, signal: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: 'started', agent: 'claude' };
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    yield { type: 'error', message: 'interrompu' };
  }
}

describe('server run cancellation', () => {
  it('aborts an in-flight run on `cancel` and frees the lock for the next one', async () => {
    const cwd = await setupGitRepo();
    const server = createServer({
      port: 0,
      cwd,
      runners: [new HangingRunner()],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const { ws, reader } = await openSocket(server.port);
      await reader.next(); // hello
      await reader.next(); // history

      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'hangs', element }));
      expect(await reader.next()).toEqual({ type: 'event', event: { type: 'started', agent: 'claude' } });

      ws.send(JSON.stringify({ type: 'cancel' }));
      expect(await reader.next()).toEqual({ type: 'error', message: 'Run annulé.' });

      // The runner unblocks, and the diff of whatever it wrote still arrives,
      // so a cancelled run stays reviewable rather than vanishing.
      expect(await reader.next()).toEqual({
        type: 'event',
        event: { type: 'error', message: 'interrompu' },
      });
      expect(await reader.next()).toEqual({ type: 'diff', files: [] });

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('refuses `cancel` when no run is in flight', async () => {
    const cwd = await setupGitRepo();
    const server = createServer({
      port: 0,
      cwd,
      runners: [new HangingRunner()],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
    });
    await server.start();

    try {
      const { ws, reader } = await openSocket(server.port);
      await reader.next(); // hello
      await reader.next(); // history

      ws.send(JSON.stringify({ type: 'cancel' }));
      expect(await reader.next()).toEqual({ type: 'error', message: 'Aucun run en cours.' });

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('aborts a run that outlives the timeout, instead of holding the lock forever', async () => {
    const cwd = await setupGitRepo();
    const server = createServer({
      port: 0,
      cwd,
      runners: [new HangingRunner()],
      allowedOriginPrefixes: [TEST_ORIGIN],
      token: TEST_TOKEN,
      runTimeoutMs: 1000,
    });
    await server.start();

    try {
      const { ws, reader } = await openSocket(server.port);
      await reader.next(); // hello
      await reader.next(); // history

      ws.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'hangs', element }));
      expect(await reader.next()).toEqual({ type: 'event', event: { type: 'started', agent: 'claude' } });

      // Nothing is sent by the client here: the server's own timer fires.
      expect(await reader.next()).toEqual({
        type: 'error',
        message: 'Run interrompu : délai de 1 s dépassé.',
      });
      expect(await reader.next()).toEqual({
        type: 'event',
        event: { type: 'error', message: 'interrompu' },
      });
      expect(await reader.next()).toEqual({ type: 'diff', files: [] });

      ws.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('server diff survival', () => {
  it('replays the last run\'s diff to a panel that connects later, and it is still undoable', async () => {
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
      const { ws: wsA, reader: readerA } = await openSocket(server.port);
      await readerA.next(); // hello
      await readerA.next(); // history

      wsA.send(JSON.stringify({ type: 'run', agent: 'claude', prompt: 'do multi', element }));
      let diffForA: ServerMessage | null = null;
      while (diffForA === null) {
        const next = await readerA.next();
        if (next.type === 'diff') diffForA = next;
      }
      expect(diffForA.type === 'diff' && diffForA.files.length).toBeGreaterThan(0);

      // The user closes the side panel. What the run changed must still be
      // visible, and still undoable, from whatever panel opens next.
      await new Promise<void>((resolve) => {
        wsA.once('close', () => resolve());
        wsA.close();
      });

      const { ws: wsC, reader: readerC } = await openSocket(server.port);
      expect((await readerC.next()).type).toBe('hello');
      const historyC = await readerC.next();
      if (historyC.type !== 'history') throw new Error('expected history');
      expect(historyC.runs).toHaveLength(1);
      const replayed = await readerC.next();
      if (replayed.type !== 'diff') throw new Error('expected the last diff to be replayed');
      expect(replayed.files.map((file) => file.path).sort()).toEqual(['new.txt', 'tracked.txt']);

      // And the new panel can still take the run back.
      wsC.send(JSON.stringify({ type: 'undo-run', id: historyC.runs[0]!.id }));
      const undone = await readerC.next();
      if (undone.type !== 'run-undone') throw new Error('expected run-undone');
      expect(undone.files.sort()).toEqual(['new.txt', 'tracked.txt']);

      expect(await fs.readFile(path.join(cwd, 'tracked.txt'), 'utf8')).toBe('original content\n');
      await expect(fs.readFile(path.join(cwd, 'new.txt'), 'utf8')).rejects.toThrow();

      wsC.close();
    } finally {
      await server.stop();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('server /health exposure', () => {
  it('does not send a wildcard CORS header, so a random page cannot read back cwd', async () => {
    const cwd = process.cwd();
    const server = createServer({ port: 0, cwd, runners: [], token: TEST_TOKEN });
    await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await server.stop();
    }
  });
});

describe('server /pair', () => {
  it('serves the pairing page for the right code and refuses any other', async () => {
    const cwd = process.cwd();
    const server = createServer({ port: 0, cwd, runners: [], token: TEST_TOKEN });
    await server.start();
    try {
      const base = `http://127.0.0.1:${server.port}/pair`;
      expect(server.pairingCode).toMatch(/^[0-9a-f]{32}$/);

      const ok = await fetch(`${base}?c=${server.pairingCode}`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toContain('text/html');
      // Not embeddable, and not cacheable: it carries the connection token.
      expect(ok.headers.get('x-frame-options')).toBe('DENY');
      expect(ok.headers.get('cache-control')).toBe('no-store');
      expect(ok.headers.get('access-control-allow-origin')).toBeNull();

      const body = await ok.text();
      expect(body).toContain(TEST_TOKEN);
      expect(body).toContain(String(server.port));

      for (const bad of ['', '?c=', '?c=wrong', `?c=${'f'.repeat(32)}`]) {
        const res = await fetch(`${base}${bad}`);
        expect(res.status).toBe(403);
        expect(await res.text()).not.toContain(TEST_TOKEN);
      }
    } finally {
      await server.stop();
    }
  });

  it('still 404s on unknown paths, and ignores the query string when routing', async () => {
    const cwd = process.cwd();
    const server = createServer({ port: 0, cwd, runners: [], token: TEST_TOKEN });
    await server.start();
    try {
      expect((await fetch(`http://127.0.0.1:${server.port}/nope`)).status).toBe(404);
      // `/health?x=1` used to miss the exact-match route and 404.
      expect((await fetch(`http://127.0.0.1:${server.port}/health?x=1`)).status).toBe(200);
    } finally {
      await server.stop();
    }
  });
});
