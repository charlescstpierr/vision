import { afterEach, describe, expect, it } from 'vitest';
import { buildSpawnCommand, isCommandAvailable, spawnCli } from './spawn.js';

describe('buildSpawnCommand', () => {
  const originalComSpec = process.env.ComSpec;
  afterEach(() => {
    if (originalComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = originalComSpec;
  });

  it('leaves POSIX executables unchanged', () => {
    expect(buildSpawnCommand('/usr/local/bin/claude', ['-p', '--verbose'], 'linux')).toEqual({
      command: '/usr/local/bin/claude',
      args: ['-p', '--verbose'],
    });
  });

  it('leaves a non-.cmd/.bat executable unchanged even on win32', () => {
    expect(buildSpawnCommand('C:\\tools\\claude.exe', ['-p'], 'win32')).toEqual({
      command: 'C:\\tools\\claude.exe',
      args: ['-p'],
    });
  });

  it('wraps a .cmd shim with ComSpec on win32, quoting args with spaces', () => {
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    const result = buildSpawnCommand('C:\\npm\\claude.cmd', ['-p', 'a value', '--verbose'], 'win32');
    expect(result).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\npm\\claude.cmd" -p "a value" --verbose'],
      windowsVerbatimArguments: true,
    });
  });

  it('wraps a .bat shim too, and defaults to cmd.exe when ComSpec is unset', () => {
    delete process.env.ComSpec;
    const result = buildSpawnCommand('C:\\npm\\codex.bat', ['exec'], 'win32');
    expect(result.command).toBe('cmd.exe');
    expect(result.args).toEqual(['/d', '/s', '/c', '"C:\\npm\\codex.bat" exec']);
    expect(result.windowsVerbatimArguments).toBe(true);
  });
});

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
