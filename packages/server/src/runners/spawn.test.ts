import { describe, expect, it } from 'vitest';
import { isCommandAvailable, spawnCli } from './spawn.js';

describe('isCommandAvailable', () => {
  it('is false for a command that does not exist', async () => {
    await expect(isCommandAvailable('definitely-not-a-command')).resolves.toBe(false);
  });

  it('is true for a command that is always present (node)', async () => {
    await expect(isCommandAvailable('node')).resolves.toBe(true);
  });
});

describe('spawnCli', () => {
  it('yields an error event when the executable does not exist', async () => {
    const controller = new AbortController();
    const events = [];
    for await (const event of spawnCli('definitely-not-a-command', [], {
      cwd: process.cwd(),
      signal: controller.signal,
    })) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as { message: string }).message).toMatch(/not found on PATH/);
  });

  it('streams stdout lines and an exit event for a real process', async () => {
    const controller = new AbortController();
    const events = [];
    for await (const event of spawnCli(
      'node',
      ['-e', 'process.stdin.on("data", d => process.stdout.write("echo:" + d)); process.stdin.resume();'],
      { cwd: process.cwd(), signal: controller.signal, stdin: 'hello\n' },
    )) {
      events.push(event);
    }
    const stdoutLines = events.filter((e) => e.type === 'stdout');
    expect(stdoutLines.length).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ type: 'exit', code: 0 });
  });
});
