import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXTENSION_PATH = path.resolve(__dirname, '../packages/extension/.output/chrome-mv3');
const PAGES_DIR = path.resolve(__dirname, 'pages');
const CHROMIUM_EXECUTABLE = '/opt/pw-browsers/chromium';
const EDGE_EXECUTABLE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

type Fixtures = {
  context: BrowserContext;
  extensionId: string;
  pageUrl: string;
};

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    if (!fs.existsSync(EXTENSION_PATH)) {
      throw new Error(
        `Built extension not found at ${EXTENSION_PATH}. Run "pnpm --filter @vizion/extension build" first.`,
      );
    }

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vizion-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      executablePath: fs.existsSync(CHROMIUM_EXECUTABLE)
        ? CHROMIUM_EXECUTABLE
        : fs.existsSync(EDGE_EXECUTABLE) ? EDGE_EXECUTABLE : undefined,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--headless=new',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    await use(context);

    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    }
    const id = worker.url().split('/')[2];
    await use(id);
  },

  // eslint-disable-next-line no-empty-pattern
  pageUrl: async ({}, use) => {
    const server = http.createServer((req, res) => {
      const reqPath = req.url && req.url !== '/' ? req.url.split('?')[0] : '/index.html';
      const filePath = path.join(PAGES_DIR, decodeURIComponent(reqPath ?? '/index.html'));
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;

    await use(`http://127.0.0.1:${port}/index.html`);

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  },
});

export { expect } from '@playwright/test';
