import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('registers once through the real API, redirects, and handles duplicates and server failures', async ({ page }, testInfo) => {
  const email = `e2e-${randomUUID()}@example.test`;
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/register');
  await expect(page).toHaveTitle('Create account · Real-time Chat');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByLabel('Display name', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('aria-invalid', 'true');

  const fill = async () => {
    await page.getByLabel('Display name', { exact: true }).fill('Browser Test');
    await page.getByLabel('Email address', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill('a unique test passphrase');
  };
  await fill();
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width === 320 || width === 1440) await page.screenshot({ path: testInfo.outputPath(`registration-${width}.png`), fullPage: true });
  }
  await page.getByLabel('Display name', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Email address', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeFocused();

  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  await page.route('**/api/auth/register', async route => {
    attempts++;
    await held;
    await route.continue();
  });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Creating account…' })).toBeDisabled();
  await page.keyboard.press('Enter');
  release();
  await expect(page).toHaveURL(/\/login\?registered=1$/);
  expect(attempts).toBe(1);
  await expect(page.getByRole('heading', { name: 'Account created' })).toBeFocused();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  await page.unroute('**/api/auth/register');

  await page.goto('/register');
  await fill();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('An account already uses this email address.');
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByLabel('Email address', { exact: true })).toHaveAttribute('aria-invalid', 'true');

  await page.getByLabel('Email address', { exact: true }).fill(`retry-${email}`);
  await page.route('**/api/auth/register', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'private diagnostic', requestId: randomUUID() }) }), { times: 1 });
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not confirm your registration');
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeEnabled();
  await expect(page.locator('body')).not.toContainText('private diagnostic');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?registered=1$/);
  expect(pageErrors).toEqual([]);
});
