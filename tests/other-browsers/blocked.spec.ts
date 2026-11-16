// Manual check 7g in real engines: Firefox and WebKit (Safari's engine) cannot share a tab's
// audio, so Trama disables recording and points to Chrome or Edge. The Chromium suite covers
// the same path with a faked User-Agent; this runs it where the browser really is different.

import { expect, test } from '@playwright/test';

test('recording is disabled with a message to use Chrome or Edge', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#grava')).toBeDisabled();
  await expect(page.locator('#missatge')).toContainText('Chrome o Edge');
  expect(errors, 'page errors').toEqual([]);
});
