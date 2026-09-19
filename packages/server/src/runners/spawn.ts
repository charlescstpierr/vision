import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Resolves the executable to hand to `spawn` with `shell: false`.
 *
 * On POSIX, libuv/execvp already searches PATH for a bare command name, so
 * the command is returned as-is. On Windows, CLIs installed via npm are
 * usually `.cmd`/`.exe` shims that `CreateProcess` cannot resolve without a
 * shell, so we look them up with `where` first.
 */
async function resolveExecutable(command: string): Promise<string> {
  if (process.platform !== 'win32') {
    return command;
  }

  const candidates = [`${command}.cmd`, `${command}.exe`, command];
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync('where', [candidate]);
      const first = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (first) return first;
    } catch {
      // Not found via `where`; try the next candidate.
    }
  }
  return command;
}

export interface BuiltSpawnCommand {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/**
 * Pure helper (no I/O) that turns a resolved executable + args into what to
 * actually hand to `child_process.spawn`.
 *
 * On POSIX this is a no-op. On Windows, npm-installed CLIs resolve (via
 * `resolveExecutable`) to a `.cmd`/`.bat` shim, which `CreateProcess` cannot
 * run directly without a shell (`ENOENT`/garbled args) since those are
 * batch files, not native executables. So instead we spawn the shell
 * (`ComSpec`, defaulting to `cmd.exe`) with `/d /s /c "<exe>" <args...>`,
 * quoting each arg that contains spaces, and set
 * `windowsVerbatimArguments: true` so Node passes that command line through
 * unmodified (its own default quoting would otherwise mangle it).
 */
export function buildSpawnCommand(
  resolvedExe: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): BuiltSpawnCommand {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(resolvedExe)) {
    return { command: resolvedExe, args };
  }
  const comspec = process.env.ComSpec ?? 'cmd.exe';
  const quotedArgs = args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg));
  const commandLine = [`"${resolvedExe}"`, ...quotedArgs].join(' ');
  return {
    command: comspec,
    args: ['/d', '/s', '/c', commandLine],
    windowsVerbatimArguments: true,
  };
}

export interface SpawnCliOptions {
  cwd: string;
  signal: AbortSignal;
  /** Text written to the child's stdin, then the stream is ended. */
  stdin?: string;
}

export type SpawnLine =
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; text: string }
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null };

/**
 * Spawns `command` (resolved cross-platform, never via a shell), writes
 * `options.stdin` (if any) then closes stdin, and yields stdout lines as
 * they arrive. Stderr is collected and surfaced once, right before the
 * final `exit` event. A failure to spawn (e.g. ENOENT) yields a single
 * `error` event with a clear message instead of throwing.
 */
export async function* spawnCli(
  command: string,
  args: string[],
  options: SpawnCliOptions,
): AsyncGenerator<SpawnLine> {
  const executable = await resolveExecutable(command);
  const built = buildSpawnCommand(executable, args);

  const queue: SpawnLine[] = [];
  let waiter: (() => void) | null = null;
  let finished = false;

  const push = (item: SpawnLine): void => {
    queue.push(item);
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve();
    }
  };

  let child: ChildProcess;
  try {
    child = nodeSpawn(built.command, built.args, {
      cwd: options.cwd,
      shell: false,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(built.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (err) {
    yield {
      type: 'error',
      message: `Failed to spawn "${command}": ${err instanceof Error ? err.message : String(err)}`,
    };
    return;
  }

  let stderrBuffer = '';

  child.on('error', (err: NodeJS.ErrnoException) => {
    const message =
      err.code === 'ENOENT'
        ? `"${command}" was not found on PATH. Is it installed?`
        : `Failed to run "${command}": ${err.message}`;
    push({ type: 'error', message });
    finished = true;
  });

  child.on('close', (code) => {
    if (stderrBuffer.trim().length > 0) {
      push({ type: 'stderr', text: stderrBuffer });
    }
    push({ type: 'exit', code });
    finished = true;
  });

  child.stdout?.setEncoding('utf8');
  const rl = child.stdout ? createInterface({ input: child.stdout }) : null;
  rl?.on('line', (line) => push({ type: 'stdout', line }));

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrBuffer += chunk;
  });

  if (child.stdin) {
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  }

  try {
    while (true) {
      if (queue.length > 0) {
        // Non-null: length checked above.
        const item = queue.shift() as SpawnLine;
        yield item;
        if (item.type === 'exit' || item.type === 'error') {
          return;
        }
        continue;
      }
      if (finished) {
        return;
      }
      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
    }
  } finally {
    rl?.close();
  }
}

/**
 * True if `command --version` runs and exits with code 0 within 5s.
 */
export async function isCommandAvailable(command: string): Promise<boolean> {
  const executable = await resolveExecutable(command);
  const built = buildSpawnCommand(executable, ['--version']);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };

    let child: ChildProcess;
    try {
      child = nodeSpawn(built.command, built.args, {
        shell: false,
        stdio: 'ignore',
        ...(built.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 5000);

    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}
