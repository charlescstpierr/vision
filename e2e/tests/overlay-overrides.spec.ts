import { test, expect } from '../fixtures.js';

test('overlay overrides persist', async ({ context, extensionId, pageUrl }) => {
  const page = await context.newPage();
  await page.goto(pageUrl);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  const overrideKey = await panel.evaluate((url) => {
    const u = new URL(url);
    return `vizion:overrides:${u.origin}${u.pathname}`;
  }, pageUrl);

  await panel.evaluate(async (key) => {
    await chrome.storage.local.set({
      [key]: [
        { id: '1', selector: '#title', kind: 'style', property: 'color', value: 'rgb(255, 0, 0)', createdAt: 1 },
        { id: '2', selector: '#title', kind: 'text', value: 'Overridden', createdAt: 2 },
      ],
    });
  }, overrideKey);

  await page.reload();

  await expect(page.locator('#title')).toHaveText('Overridden');
  await expect(page.locator('#title')).toHaveCSS('color', 'rgb(255, 0, 0)');
  await expect(page.locator('#vizion-overrides')).toHaveCount(1);
});
