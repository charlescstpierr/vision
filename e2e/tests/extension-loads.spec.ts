import { test, expect } from '../fixtures.js';

test('extension loads', async ({ context, extensionId }) => {
  expect(extensionId).toBeTruthy();

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await expect(panel.locator('h1')).toHaveText('Vizion');
  await expect(panel.getByText('Server not running', { exact: false })).toBeVisible();
});
