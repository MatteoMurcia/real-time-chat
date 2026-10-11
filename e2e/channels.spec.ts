import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

test('creates a channel and manages independent memberships including a lost leave response', async ({ page, browser }, testInfo) => {
  const suffix = randomUUID();
  const slug = `team-${suffix}`;
  const name = `Team ${suffix}`;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const signUp = async (target: Page, user: string) => {
    await target.goto('/register');
    await target.getByLabel('Display name', { exact: true }).fill('Channel Browser');
    await target.getByLabel('Email address', { exact: true }).fill(`${user}-${suffix}@example.test`);
    await target.getByLabel('Password', { exact: true }).fill('a unique channel passphrase');
    await target.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(target).toHaveURL(/\/login\?registered=1$/);
    await target.getByLabel('Email address', { exact: true }).fill(`${user}-${suffix}@example.test`);
    await target.getByLabel('Password', { exact: true }).fill('a unique channel passphrase');
    await target.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(target.getByRole('button', { name: 'Create channel', exact: true })).toBeEnabled();
  };
  await signUp(page, 'creator');
  await page.getByRole('button', { name: 'Create channel', exact: true }).click();
  await expect(page.getByLabel('Channel name', { exact: true })).toBeFocused();
  await page.getByLabel('Channel name', { exact: true }).fill(name);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Channel slug', { exact: true })).toBeFocused();
  await page.getByLabel('Channel slug', { exact: true }).fill(slug);
  let attempts = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/channels', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts++;
    await held;
    await route.continue();
  });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Creating channel…', exact: true })).toBeDisabled();
  await page.keyboard.press('Enter');
  release();
  await expect(page.locator('#channel-notice')).toHaveText(`Created #${slug}. You are a member.`);
  await expect(page.locator('#channel-notice')).toBeFocused();
  expect(attempts).toBe(1);
  await page.unroute('**/api/channels');
  const row = page.getByRole('listitem').filter({ hasText: `#${slug}` });
  await expect(row).toContainText('Member');
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width === 320 || width === 1440) await page.screenshot({ path: testInfo.outputPath(`channels-${width}.png`), fullPage: true });
  }
  await page.getByLabel('Channel name', { exact: true }).fill(name.toUpperCase());
  await page.getByLabel('Channel slug', { exact: true }).fill(`new-${suffix}`);
  await page.getByRole('button', { name: 'Create channel', exact: true }).click();
  await expect(page.locator('#channel-error')).toHaveText('A channel already uses this name or slug.');
  await expect(page.locator('#channel-error')).toBeFocused();
  await page.route('**/api/channels', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
  await page.getByRole('button', { name: 'Refresh channels', exact: true }).click();
  await expect(page.getByText('Could not load channels. Try again.', { exact: true })).toBeVisible();
  await expect(row).toBeVisible();
  await page.getByRole('button', { name: 'Refresh channels', exact: true }).click();
  await expect(page.getByText('Could not load channels. Try again.', { exact: true })).not.toBeVisible();
  const other = await browser.newContext({ baseURL: process.env.E2E_BASE_URL! });
  try {
    const second = await other.newPage();
    second.on('pageerror', error => errors.push(error.message));
    await signUp(second, 'observer');
    const otherRow = second.getByRole('listitem').filter({ hasText: `#${slug}` });
    await expect(otherRow).toContainText('Open channel');
    let membershipAttempts = 0;
    let releaseJoin!: () => void;
    const joinHeld = new Promise<void>(resolve => { releaseJoin = resolve; });
    await second.route('**/api/channels/*/membership', async route => {
      membershipAttempts++;
      await joinHeld;
      await route.continue();
    });
    await otherRow.getByRole('button', { name: `Join ${name}`, exact: true }).focus();
    await second.keyboard.press('Enter');
    await expect(otherRow.getByRole('button')).toBeDisabled();
    await second.keyboard.press('Enter');
    releaseJoin();
    await expect(otherRow.getByRole('button', { name: `Leave ${name}`, exact: true })).toBeEnabled();
    await expect(otherRow.getByRole('button')).toBeFocused();
    expect(membershipAttempts).toBe(1);
    await second.unroute('**/api/channels/*/membership');
    await second.route('**/api/channels/*/membership', async route => {
      expect(route.request().method()).toBe('DELETE');
      const committed = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
      expect(committed.status()).toBe(200);
      expect((await committed.json()).isMember).toBe(false);
      await route.abort('failed');
    }, { times: 1 });
    await otherRow.getByRole('button', { name: `Leave ${name}`, exact: true }).click();
    await expect(otherRow).toContainText('Status unconfirmed');
    for (const width of [320, 768, 1024, 1440]) {
      await second.setViewportSize({ width, height: 900 });
      expect(await second.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (width === 320 || width === 1440) await second.screenshot({ path: testInfo.outputPath(`membership-${width}.png`), fullPage: true });
    }
    await otherRow.getByRole('button', { name: `Retry Leave ${name}`, exact: true }).click();
    await expect(otherRow.getByRole('button', { name: `Join ${name}`, exact: true })).toBeEnabled();
    await second.reload();
    await expect(otherRow).toContainText('Open channel');
    await page.getByRole('button', { name: 'Refresh channels', exact: true }).click();
    await expect(row.getByRole('button', { name: `Leave ${name}`, exact: true })).toBeEnabled();
    const response = await second.request.get('/api/channels');
    expect(response.status()).toBe(200);
  } finally { await other.close(); }
  expect(errors).toEqual([]);
});
