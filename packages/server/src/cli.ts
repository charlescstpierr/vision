#!/usr/bin/env node
import { createRequire } from 'node:module';
import { DEFAULT_PORT } from '@vizion/shared';
import { createServer } from './server.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

const USAGE = `Usage: vizion [options]

Run the Vizion local server in your project folder so the Vizion browser
extension can pair with a coding agent (Claude or Codex) to edit this
project's live pages.

Options:
  --port <number>  Port to listen on (default: ${DEFAULT_PORT})
  -h, --help       Print this help message
  --version        Print the installed version
`;

function parsePort(argv: string[]): number {
  const idx = argv.indexOf('--port');
  if (idx !== -1 && argv[idx + 1]) {
    const parsed = Number.parseInt(argv[idx + 1] as string, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return DEFAULT_PORT;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  if (argv.includes('--version')) {
    console.log(pkg.version);
    return;
  }

  const port = parsePort(argv);
  const cwd = process.cwd();
  const server = createServer({ port, cwd });
  await server.start();
  console.log(`Vizion server listening on http://127.0.0.1:${server.port} (project: ${cwd})`);
  console.log(
    server.agents.length > 0
      ? `Detected agents: ${server.agents.join(', ')}`
      : 'No agents detected: install codex or claude',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
