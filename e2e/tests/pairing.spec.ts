import { test, expect } from '../fixtures.js';

test('one-click pairing: open the URL the server prints, then confirm in the panel', async ({
  context,
  extensionId,
  vizionServer,
}) => {
  // Open the pairing URL the CLI printed to stdout (packages/server/src/cli.ts),
  // exactly like a person would after running `npx vizion`.
  const pairPage = await context.newPage();
  await pairPage.goto(vizionServer.pairUrl);

  // The content script (packages/extension/utils/pairing.ts, handlePairingPage)
  // reads the payload embedded in the page and marks `<html>` once it has
  // stored it, which flips the page's own "en attente" -> "détecté" copy.
  await expect(pairPage.locator('html')).toHaveAttribute('data-vizion-paired', '');
  await expect(pairPage.getByText('Détecté par l\'extension', { exact: false })).toBeVisible();

  // Open the side panel: it should offer to confirm the pairing it just saw,
  // naming the project directory so the user can recognise it.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await expect(panel.getByText('Appairer Vizion ?')).toBeVisible();
  await expect(panel.getByText(vizionServer.repoDir)).toBeVisible();

  await panel.getByRole('button', { name: 'Appairer' }).click();

  // Confirming writes `vizion:settings` (see useSettings.ts) and the panel
  // reconnects to the now-known port/token without needing a reload.
  await pairPage.bringToFront();
  await expect(panel.getByText(/connecté à/)).toBeVisible();
  await expect(panel.getByText(vizionServer.repoDir)).toBeVisible();

  // The pairing offer is gone once applied.
  await expect(panel.getByText('Appairer Vizion ?')).toHaveCount(0);
});
