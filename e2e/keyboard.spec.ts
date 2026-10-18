import { randomUUID } from 'node:crypto';
import { expect, test, type Locator } from '@playwright/test';

test('completes registration, channel creation and composition using the keyboard without losing focus', async ({ page, context }) => {
  const suffix = randomUUID(), name = `Keyboard ${suffix}`, slug = `keyboard-${suffix}`;
  const email = `keyboard-${suffix}@example.test`, password = 'a unique keyboard passphrase';
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const tabTo = async (target: Locator) => {
    await expect(target).toBeVisible(); await expect(target).toBeEnabled();
    for (let count = 0; count < 150 && !await target.evaluate(element => element === document.activeElement); count++) await page.keyboard.press('Tab');
    await expect(target).toBeFocused();
  };
  const type = async (label: string, value: string) => {
    await tabTo(page.getByLabel(label, { exact: true })); await page.keyboard.insertText(value);
  };
  await page.goto('/register');
  await expect(page.getByRole('heading', { name: 'Create your account', exact: true })).toBeFocused();
  // Empty submission must return to the first invalid field.
  await tabTo(page.getByRole('button', { name: 'Create account', exact: true })); await page.keyboard.press('Enter');
  await expect(page.getByLabel('Display name', { exact: true })).toBeFocused();
  await type('Display name', 'Keyboard Reader'); await type('Email address', email); await type('Password', password);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Account created', exact: true })).toBeFocused();
  await type('Email address', email); await type('Password', password); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Welcome, Keyboard Reader', exact: true })).toBeFocused();
  await type('Channel name', name); await type('Channel slug', slug); await page.keyboard.press('Enter');
  await expect(page.locator('#channel-notice')).toBeFocused();
  const open = page.getByRole('button', { name: `Open chat ${name}`, exact: true });
  await tabTo(open); await page.keyboard.press('Enter');
  await expect(page.locator('#conversation-title')).toBeFocused();
  await expect(page.getByText('No messages yet. Say hello.', { exact: true })).toBeVisible();
  const composer = page.getByLabel('Message', { exact: true }), rows = page.getByRole('log').locator('article');
  await tabTo(composer);
  // Chromium protocol drives composition events; the terminating 229 edge is synthetic, not an OS IME.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
  await composer.dispatchEvent('keydown', { key: 'Enter', isComposing: false });
  await page.locator('app-chat form').dispatchEvent('submit');
  await expect(composer).toHaveValue('にほん'); await expect(rows).toHaveCount(0);
  await cdp.send('Input.insertText', { text: '日本語' });
  await composer.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: false });
  await expect(composer).toHaveValue('日本語'); await expect(rows).toHaveCount(0);
  for (const modifier of ['Control', 'Alt', 'Meta']) await page.keyboard.press(`${modifier}+Enter`);
  await expect(composer).toHaveValue('日本語'); await expect(rows).toHaveCount(0);
  await page.keyboard.press('Shift+Enter'); await page.keyboard.insertText('Second line'); await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(1); await expect(rows.first().locator('.body')).toHaveText('日本語\nSecond line');
  await expect(composer).toHaveValue(''); await expect(composer).toBeFocused();
  await page.keyboard.insertText('Button send'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(2); await expect(composer).toBeFocused();
  await tabTo(page.getByRole('button', { name: 'Close conversation', exact: true })); await page.keyboard.press('Enter');
  await expect(page.locator('#channels-title')).toBeFocused();
  await expect(page.locator('app-chat')).toHaveCount(0);
  await tabTo(open); await page.keyboard.press('Enter'); await expect(page.locator('#conversation-title')).toBeFocused();
  await tabTo(composer); await page.keyboard.insertText('Draft stays focused');
  const origin = process.env.E2E_BASE_URL!;
  const csrf = (await (await context.request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken;
  const response = await context.request.post('/api/channels', { headers: { origin, 'x-csrf-token': csrf }, data: { name: `Other ${suffix}`, slug: `other-${suffix}` } });
  expect(response.status()).toBe(201);
  // An explicit directory refresh must not move focus back into a reused conversation on live renders.
  await tabTo(page.getByRole('button', { name: 'Refresh channels', exact: true })); await page.keyboard.press('Enter');
  await tabTo(page.getByRole('button', { name: `Open chat Other ${suffix}`, exact: true })); await page.keyboard.press('Enter');
  await expect(page.locator('#conversation-title')).toBeFocused();
  await expect(composer).toHaveValue('');
  await page.screenshot({ path: 'test-results/keyboard-desktop.png', fullPage: true });
  await cdp.detach(); expect(errors).toEqual([]);
});
