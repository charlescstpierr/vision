import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentRunner } from '../../packages/shared/src/agent.js';
import { createServer } from '../../packages/server/src/server.js';
import { test, expect } from '../fixtures.js';

const exec = promisify(execFile);

test('source capture sends annotated pixels and recovers its decision after panel reload', async ({
  context, extensionId, pageUrl,
}, testInfo) => {
  test.setTimeout(60_000);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'vizion-browser-source-'));
  await exec('git', ['init', '-q'], { cwd });
  await fs.writeFile(path.join(cwd, 'tracked.txt'), 'original\n');
  await exec('git', ['add', '.'], { cwd });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init'], { cwd });
  let resolveCapture!: (data: Buffer) => void;
  const captured = new Promise<Buffer>((resolve) => { resolveCapture = resolve; });
  const runner: AgentRunner = {
    kind: 'claude',
    isAvailable: async () => true,
    async *run(request) {
      if (!request.screenshotPath) throw new Error('annotated screenshot missing');
      resolveCapture(await fs.readFile(request.screenshotPath));
      await fs.writeFile(path.join(cwd, 'tracked.txt'), 'agent\n');
      yield { type: 'done', exitCode: 0 };
    },
  };
  const token = 'browser-source-token';
  const server = createServer({ port: 0, cwd, runners: [runner], token });
  await server.start();
  try {
    const page = await context.newPage();
    await page.goto(pageUrl);
    await page.addStyleTag({ content: '#main { width: 600px; height: 300px; padding: 12px; background: #eef1f7; }' });
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.evaluate(async ({ port, token: secret }) => {
      await chrome.storage.local.set({ 'vizion:settings': { port, token: secret } });
    }, { port: server.port!, token });
    await panel.reload();
    await expect(panel.getByText('Connecté à', { exact: false })).toBeVisible();
    const tabId = await panel.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({ url });
      return tabs[0]?.id;
    }, pageUrl);
    expect(tabId).toBeTruthy();
    const panelTabId = await panel.evaluate(async () => (await chrome.tabs.getCurrent())?.id);
    expect(panelTabId).toBeTruthy();
    // Playwright opens sidepanel.html as a tab. Unlike the native side panel,
    // focusing its controls makes it the active tab. Keep the fixture page as
    // the target and supply its actual rendered pixels to the Chrome capture
    // API; cropping, annotation, WebSocket and server decoding remain real.
    const sourcePixels = (await page.screenshot()).toString('base64');
    await panel.evaluate(({ url, pixels }) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = ((info: chrome.tabs.QueryInfo) =>
        query(info.active ? { url } : info)) as typeof chrome.tabs.query;
      chrome.tabs.captureVisibleTab = (async () =>
        `data:image/png;base64,${pixels}`) as typeof chrome.tabs.captureVisibleTab;
    }, { url: pageUrl, pixels: sourcePixels });
    // Keep the test panel tab foreground so Edge does not suspend its socket.
    // The native side panel is foreground without replacing the page tab.
    await panel.evaluate(async (id) => { await chrome.tabs.update(id!, { active: true }); }, tabId);
    await panel.bringToFront();
    await expect(panel.getByText('Mode Source', { exact: false }).first()).toBeVisible();
    await panel.evaluate(async (id) => {
      await chrome.tabs.sendMessage(id!, { type: 'vizion:set-select-mode', enabled: true });
    }, tabId);
    await page.locator('#main').click({ position: { x: 480, y: 220 } });
    await panel.evaluate(async (id) => { await chrome.tabs.update(id!, { active: true }); }, panelTabId);
    await expect(panel.getByText('Élément sélectionné')).toBeVisible();

    await panel.getByLabel('Prompt').fill('Change le bouton indiqué par les marques.');
    const clickSend = async (label: string) => panel.evaluate(async (name) => {
      const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent === name);
      if (!button || button.disabled) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        throw new Error(`Send unavailable: ${name}; ${JSON.stringify({
          active: active?.url,
          status: document.body.innerText.slice(0, 350),
          selected: document.body.innerText.includes('Élément sélectionné'),
          button: button?.outerHTML,
        })}`);
      }
      button.click();
    }, label);
    // A CDP mouse click activates the panel *tab* before dispatching the
    // event; the native side panel does not activate a tab. Dispatch on its
    // real DOM button without that test-harness-only tab switch.
    await clickSend("Envoyer à l'agent");
    const editor = panel.getByRole('region', { name: 'Capture à envoyer' });
    await expect(editor).toBeVisible();
    const canvas = editor.getByRole('application', { name: /Capture :/ });
    const drag = async (a: [number, number], b: [number, number]) => {
      for (const [type, point] of [
        ['pointerdown', a], ['pointermove', b], ['pointerup', b],
      ] as const) {
        await canvas.evaluate((element, { eventType, position }) => {
          const box = element.getBoundingClientRect();
          // Synthetic pointer events do not register with the browser's
          // pointer-capture table; React still receives the same geometry.
          element.setPointerCapture = () => {};
          element.dispatchEvent(new PointerEvent(eventType, {
            bubbles: true, pointerId: 1, button: 0,
            clientX: box.left + box.width * position[0],
            clientY: box.top + box.height * position[1],
          }));
        }, { eventType: type, position: point });
      }
    };
    await drag([0.1, 0.25], [0.75, 0.6]);
    await expect(editor.getByRole('button', { name: 'Annuler (1)' })).toBeEnabled();
    await editor.getByRole('radio', { name: 'Cercle' }).evaluate((input: HTMLInputElement) => input.click());
    await drag([0.2, 0.8], [0.55, 0.95]);
    await editor.screenshot({ path: testInfo.outputPath('annotations-desktop.png') });
    await expect(editor.getByRole('button', { name: 'Annuler (2)' })).toBeEnabled();
    await editor.getByRole('button', { name: 'Annuler (2)' }).evaluate((button: HTMLButtonElement) => button.click());
    await editor.getByRole('button', { name: 'Tout effacer' }).evaluate((button: HTMLButtonElement) => button.click());
    await editor.getByRole('button', { name: 'Annuler (2)' }).evaluate((button: HTMLButtonElement) => button.click());
    await editor.getByRole('radio', { name: 'Cercle' }).evaluate((input: HTMLInputElement) => input.click());
    await drag([0.2, 0.8], [0.55, 0.95]);
    await panel.setViewportSize({ width: 390, height: 800 });
    await editor.screenshot({ path: testInfo.outputPath('annotations-mobile.png') });
    await panel.evaluate(async (id) => { await chrome.tabs.update(id!, { active: true }); }, panelTabId);
    await expect(panel.getByText('Connecté à', { exact: false })).toBeVisible();
    await clickSend('Envoyer avec la capture annotée');
    const bytes = await captured;
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    await panel.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/jpeg;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i]! > 160 && pixels[i]! > pixels[i + 1]! * 1.5 && pixels[i]! > pixels[i + 2]! * 1.5) red++;
      }
      if (red < 20) throw new Error(`annotations missing from transmitted image: ${red} red pixels`);
    }, bytes.toString('base64'));

    await expect(panel.getByText('Modifications (1 fichier)')).toBeVisible();
    await panel.reload();
    await expect(panel.getByText('Modifications (1 fichier)')).toBeVisible();
    await panel.getByRole('button', { name: 'Rejeter' }).click();
    await expect(panel.getByText('1 fichier restauré.')).toBeVisible();
    expect(await fs.readFile(path.join(cwd, 'tracked.txt'), 'utf8')).toBe('original\n');
  } finally {
    await context.close();
    await server.stop();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
