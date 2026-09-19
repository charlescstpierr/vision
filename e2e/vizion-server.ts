import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_CLI = path.resolve(__dirname, '../packages/server/dist/cli.js');
/** Directory containing the fake `claude` CLI (e2e/fake-agent/claude); prefixed onto the
 * server's PATH so it is found before any real `claude`/`codex` that might happen to be
 * installed on the machine running these tests. */
const FAKE_AGENT_DIR = path.resolve(__dirname, 'fake-agent');

const STARTUP_TIMEOUT_MS = 10_000;

export interface VizionTestServer {
  /** The temporary git repo the server was started in (its `cwd`); read/write it directly to assert on disk state. */
  repoDir: string;
  port: number;
  token: string;
  /** The one-click pairing URL the CLI printed, e.g. `http://127.0.0.1:<port>/pair?c=<code>`. */
  pairUrl: string;
  /** Kills the server process and removes the temporary repo/home directories. */
  stop(): Promise<void>;
}

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await fsp.writeFile(path.join(dir, 'README.md'), '# Vizion e2e fixture repo\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: dir });
  await execFileAsync(
    'git',
    ['-c', 'user.name=Vizion E2E', '-c', 'user.email=e2e@vizion.test', 'commit', '-q', '-m', 'init'],
    { cwd: dir },
  );
}

interface ParsedStartup {
  port: number;
  token: string;
  pairUrl: string;
}

/**
 * Reads the CLI's stdout (packages/server/src/cli.ts's `main()`) until it has
 * printed the bound port, the one-click pairing URL and the fallback token,
 * or rejects if it exits first / takes too long. Matched with regexes against
 * the exact French strings `cli.ts` prints, not by position, so reordering
 * that output would only need matching regex tweaks here.
 */
function parseStartup(child: ChildProcess): Promise<ParsedStartup> {
  return new Promise((resolve, reject) => {
    let port: number | null = null;
    let token: string | null = null;
    let pairUrl: string | null = null;
    let stderrText = '';
    let stdoutText = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `vizion server did not print its port/pairing URL/token within ${STARTUP_TIMEOUT_MS}ms.\n` +
              `stdout so far: ${stdoutText}\nstderr so far: ${stderrText}`,
          ),
        ),
      );
    }, STARTUP_TIMEOUT_MS);

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      stdoutText += `${line}\n`;

      const portMatch = /127\.0\.0\.1:(\d+)/.exec(line);
      if (portMatch && port === null) port = Number(portMatch[1]);

      const pairMatch = /(http:\/\/127\.0\.0\.1:\d+\/pair\?c=[0-9a-f]+)/.exec(line);
      if (pairMatch) pairUrl = pairMatch[1] ?? null;

      const tokenMatch = /réglages\s*:\s*([0-9a-f]+)/.exec(line);
      if (tokenMatch) token = tokenMatch[1] ?? null;

      if (port !== null && token !== null && pairUrl !== null) {
        finish(() => resolve({ port: port as number, token: token as string, pairUrl: pairUrl as string }));
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8');
    });

    child.on('exit', (code) => {
      finish(() =>
        reject(new Error(`vizion server exited early (code ${code}) before printing startup info.\nstderr: ${stderrText}`)),
      );
    });
  });
}

/**
 * Starts the real Vizion server (`packages/server/dist/cli.js`, built by
 * `pnpm --filter @charlescstpierr/vizion build`) against a throwaway git
 * repo, with the fake `claude` CLI (e2e/fake-agent/claude) prefixed onto
 * PATH and an isolated HOME — so it creates its own token/history under a
 * temp `~/.vizion` rather than touching the real one.
 */
export async function startVizionServer(): Promise<VizionTestServer> {
  if (!fs.existsSync(SERVER_CLI)) {
    throw new Error(
      `Built server not found at ${SERVER_CLI}. Run "pnpm --filter @charlescstpierr/vizion build" first.`,
    );
  }

  const repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vizion-e2e-repo-'));
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vizion-e2e-home-'));

  let child: ChildProcess;
  try {
    await initGitRepo(repoDir);

    child = spawn(process.execPath, [SERVER_CLI, '--port', '0'], {
      cwd: repoDir,
      env: {
        ...process.env,
        PATH: `${FAKE_AGENT_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
        HOME: homeDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    await fsp.rm(repoDir, { recursive: true, force: true });
    await fsp.rm(homeDir, { recursive: true, force: true });
    throw err;
  }

  let parsed: ParsedStartup;
  try {
    parsed = await parseStartup(child);
  } catch (err) {
    child.kill();
    await fsp.rm(repoDir, { recursive: true, force: true });
    await fsp.rm(homeDir, { recursive: true, force: true });
    throw err;
  }

  async function stop(): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise<void>((resolve) => {
        const onExit = () => resolve();
        child.once('exit', onExit);
        setTimeout(() => {
          child.off('exit', onExit);
          resolve();
        }, 2000);
      });
    }
    await fsp.rm(repoDir, { recursive: true, force: true });
    await fsp.rm(homeDir, { recursive: true, force: true });
  }

  return { repoDir, port: parsed.port, token: parsed.token, pairUrl: parsed.pairUrl, stop };
}
