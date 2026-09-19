#!/usr/bin/env node
import { createRequire } from 'node:module';
import { DEFAULT_PORT } from '@vizion/shared';
import { createServer } from './server.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

const USAGE = `Usage : vizion [options]

Démarre le serveur local Vizion dans le dossier de ton projet pour que
l'extension de navigateur Vizion puisse se jumeler à un agent de code
(Claude ou Codex) et modifier les pages en direct de ce projet.

Options :
  --port <number>  Port d'écoute (par défaut : ${DEFAULT_PORT})
  -h, --help       Affiche ce message d'aide
  --version        Affiche la version installée
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
  console.log(`Serveur Vizion à l'écoute sur http://127.0.0.1:${server.port} (projet : ${cwd})`);
  console.log(
    server.agents.length > 0
      ? `Agents détectés : ${server.agents.join(', ')}`
      : 'Aucun agent détecté : installe codex ou claude',
  );
  console.log('');
  console.log("Appairage — ouvre cette URL dans le navigateur où Vizion est installé :");
  console.log(`  http://127.0.0.1:${server.port}/pair?c=${server.pairingCode}`);
  console.log("L'extension la détecte, puis tu confirmes dans le panneau latéral. À faire une seule fois.");
  console.log('');
  console.log(`Sinon, colle ce jeton à la main dans les réglages : ${server.token}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
