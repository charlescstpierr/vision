import { test, expect } from '../fixtures.js';

test('content script and selection', async ({ context, extensionId, pageUrl }) => {
  const page = await context.newPage();
  await page.goto(pageUrl);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  const tabId = await panel.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    return tabs[0]?.id;
  }, pageUrl);
  expect(tabId).toBeTruthy();

  await panel.evaluate(async (id) => {
    await chrome.tabs.sendMessage(id as number, { type: 'vizion:set-select-mode', enabled: true });
  }, tabId);

  const btn = page.locator('.btn');
  await btn.hover();
  await btn.click();

  await expect(panel.getByText('Élément sélectionné')).toBeVisible();
  const bodyText = await panel.evaluate(() => document.body.innerText);
  expect(bodyText).toContain('button');
  expect(/\.btn|#main/.test(bodyText)).toBe(true);
});
