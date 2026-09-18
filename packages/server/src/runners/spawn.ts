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
    child = nodeSpawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
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
      child = nodeSpawn(executable, ['--version'], {
        shell: false,
        stdio: 'ignore',
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
