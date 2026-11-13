const { test, expect } = require('@playwright/test');

test('self-test stays green', async ({ page }) => {
  await page.goto('http://127.0.0.1:8765/index.html?selftest=1', { waitUntil: 'networkidle' });
  await expect(page).toHaveTitle('SELFTEST 95/95');
});

test('demo and tie demo load', async ({ page }) => {
  await page.goto('http://127.0.0.1:8765/index.html?demo=1&tie=1', { waitUntil: 'networkidle' });
  await expect(page.locator('#roll')).toBeVisible();
  await expect(page.locator('#staffHost')).toBeVisible();
  await expect(page.locator('#jianpuHost')).toBeVisible();
  const footerVersion = await page.locator('#verTag').textContent();
  await expect(page.locator('#railVer')).toHaveText(footerVersion);
});
