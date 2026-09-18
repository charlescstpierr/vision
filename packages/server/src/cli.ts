#!/usr/bin/env node
import { DEFAULT_PORT } from '@vizion/shared';
import { createServer } from './server.js';

function parsePort(argv: string[]): number {
  const idx = argv.indexOf('--port');
  if (idx !== -1 && argv[idx + 1]) {
    const parsed = Number.parseInt(argv[idx + 1] as string, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return DEFAULT_PORT;
}

async function main(): Promise<void> {
  const port = parsePort(process.argv.slice(2));
  const cwd = process.cwd();
  const server = createServer({ port, cwd });
  await server.start();
  console.log(`Vizion server listening on http://127.0.0.1:${port} (project: ${cwd})`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
