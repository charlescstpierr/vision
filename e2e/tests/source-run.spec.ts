import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from '@playwright/test';
import { test, expect } from '../fixtures.js';

/** Must match the filename e2e/fake-agent/claude writes into its cwd. */
const FAKE_AGENT_OUTPUT_FILE = 'vizion-fake-agent-output.txt';

/**
 * Writes `vizion:settings` (the key `useSettings.ts` reads/writes, see
 * packages/extension/entrypoints/sidepanel/hooks/useSettings.ts) from the
 * extension's own service worker, before the side panel is ever opened —
 * the same shape a real user gets by confirming a pairing offer.
 */
async function configureSettings(context: BrowserContext, port: number, token: string): Promise<void> {
  const [worker] = context.serviceWorkers();
  await worker!.evaluate(
    async ({ port, token }) => {
      await chrome.storage.local.set({ 'vizion:settings': { port, token } });
    },
    { port, token },
  );
}

test('Source mode: connects to the real server and selects an element on the page', async ({
  context,
  extensionId,
  pageUrl,
  vizionServer,
}) => {
  await configureSettings(context, vizionServer.port, vizionServer.token);

  const page = await context.newPage();
  await page.goto(pageUrl);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  // `App.tsx`'s `isSourceMode` requires both a live connection *and* the
  // active tab being a local URL (see `isLocalUrl` in
  // packages/extension/utils/url.ts) — bring the test page to the front so
  // it, not the panel tab, is what `useActiveTab` reports.
  await page.bringToFront();

  await expect(panel.getByText(/Mode Source · connecté à/)).toBeVisible();
  await expect(panel.getByText(vizionServer.repoDir)).toBeVisible();

  // Select an element on the page, the same way content-selection.spec.ts does.
  const tabId = await panel.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    return tabs[0]?.id;
  }, pageUrl);
  expect(tabId).toBeTruthy();

  await panel.evaluate(async (id) => {
    await chrome.tabs.sendMessage(id as number, { type: 'vizion:set-select-mode', enabled: true });
  }, tabId);

  await page.locator('#title').click();
  await expect(panel.getByText('Élément sélectionné')).toBeVisible();
  const bodyText = await panel.evaluate(() => document.body.innerText);
  expect(bodyText).toContain('#title');
});

/**
 * The full Source-mode loop. This was blocked by a stale-reconnect bug in
 * `useVizionServer`: the panel flipped back to "disconnected" about a second
 * after connecting, which disabled the send button mid-click. Fixed by
 * scoping the effect's guard state to each run, and this test is what proves
 * it stays fixed -- it cannot pass while the panel cannot hold a connection.
 */
test(
  'Source mode: run an agent, see the diff, find it in history, and undo it',
  async ({ context, extensionId, pageUrl, vizionServer }) => {
    await configureSettings(context, vizionServer.port, vizionServer.token);

    const page = await context.newPage();
    await page.goto(pageUrl);

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.bringToFront();

    await expect(panel.getByText(/Mode Source · connecté à/)).toBeVisible();

    const tabId = await panel.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({ url });
      return tabs[0]?.id;
    }, pageUrl);
    await panel.evaluate(async (id) => {
      await chrome.tabs.sendMessage(id as number, { type: 'vizion:set-select-mode', enabled: true });
    }, tabId);
    await page.locator('#title').click();
    await expect(panel.getByText('Élément sélectionné')).toBeVisible();

    await panel.getByPlaceholder('ex. Mets ce bouton en bleu').fill('Ajoute un fichier de test');
    await panel.getByRole('button', { name: "Envoyer à l'agent" }).click();

    // The agent's own transcript line lands first...
    await expect(panel.getByText(`J'ai créé ${FAKE_AGENT_OUTPUT_FILE}`, { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    // ...then the diff of what it wrote, already applied on disk. `exact` so
    // this matches the file's row in the diff, not the transcript line above
    // it nor the patch body below it, which both contain the same name.
    await expect(panel.getByText(/Modifié par le dernier run/)).toBeVisible();
    await expect(panel.getByText(FAKE_AGENT_OUTPUT_FILE, { exact: true })).toBeVisible();
    await expect(panel.getByText('added', { exact: true })).toBeVisible();

    await expect(panel.getByText('appliqué', { exact: true })).toBeVisible();
    await expect
      .poll(() => fs.existsSync(path.join(vizionServer.repoDir, FAKE_AGENT_OUTPUT_FILE)))
      .toBe(true);

    await panel.getByRole('button', { name: 'Annuler ce run' }).click();
    await expect(panel.getByText(/Run annulé/)).toBeVisible();
    await expect(panel.getByText('annulé', { exact: true })).toBeVisible();
    await expect
      .poll(() => fs.existsSync(path.join(vizionServer.repoDir, FAKE_AGENT_OUTPUT_FILE)))
      .toBe(false);
  },
);
