import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

test('two independent users converse once, remount, reconnect and lose access on leave', async ({ page, browser }, testInfo) => {
  test.setTimeout(90000);
  const suffix = randomUUID();
  const name = `Conversation ${suffix}`;
  const slug = `chat-${suffix}`;
  const errors: string[] = [];
  const violations: string[] = [];
  const signIn = async (target: Page, user: string) => {
    target.on('pageerror', error => errors.push(error.message));
    await target.exposeFunction('recordCspViolation', (directive: string) => violations.push(directive));
    await target.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', event => {
        void (window as unknown as { recordCspViolation: (directive: string) => Promise<void> }).recordCspViolation(event.violatedDirective);
      });
    });
    await target.goto('/register');
    await target.getByLabel('Display name', { exact: true }).fill(user);
    await target.getByLabel('Email address', { exact: true }).fill(`${user}-${suffix}@example.test`);
    await target.getByLabel('Password', { exact: true }).fill('a unique conversation passphrase');
    await target.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(target).toHaveURL(/\/login\?registered=1$/);
    await target.getByLabel('Email address', { exact: true }).fill(`${user}-${suffix}@example.test`);
    await target.getByLabel('Password', { exact: true }).fill('a unique conversation passphrase');
    await target.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(target.getByText('Live connection established.', { exact: true })).toBeVisible();
  };
  const open = async (target: Page) => {
    await target.getByRole('button', { name: `Open chat ${name}`, exact: true }).click();
    await expect(target.getByText(/^Live conversation ready\./)).toBeVisible();
  };
  const messages = (target: Page) => target.getByRole('log', { name: 'Conversation messages' }).locator('article');
  const send = async (target: Page, text: string) => {
    await target.getByLabel('Message', { exact: true }).fill(text);
    await target.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(target.getByLabel('Message', { exact: true })).toHaveValue('');
  };
  const other = await browser.newContext({ baseURL: process.env.E2E_BASE_URL! });
  try {
    const second = await other.newPage();
    await signIn(page, 'Alice');
    await page.getByLabel('Channel name', { exact: true }).fill(name);
    await page.getByLabel('Channel slug', { exact: true }).fill(slug);
    await page.getByRole('button', { name: 'Create channel', exact: true }).click();
    await expect(page.locator('#channel-notice')).toContainText('Created');
    await signIn(second, 'Bob');
    await expect(second.getByRole('button', { name: `Open chat ${name}`, exact: true })).toHaveCount(0);
    await second.getByRole('button', { name: `Join ${name}`, exact: true }).click();
    await open(page); await open(second);
    await expect(page.locator('#conversation-title')).toBeFocused();

    const literal = '<img src=/xss-probe onerror="document.documentElement.dataset.xss=1"><svg onload="document.documentElement.dataset.xss=1"></svg><script>document.documentElement.dataset.xss=1</script> Hello 👋';
    await send(page, literal);
    for (const target of [page, second]) {
      await expect(messages(target)).toHaveCount(1);
      await expect(messages(target).locator('img, svg, script')).toHaveCount(0);
      await expect(messages(target).first()).toContainText(literal);
      await expect(messages(target).first()).toContainText('Alice');
      await expect(messages(target).first()).toContainText('Confirmed');
      expect(await target.locator('html').getAttribute('data-xss')).toBeNull();
      await expect(messages(target).locator('time')).toHaveAttribute('datetime', /^\d{4}-/);
    }
    expect(await messages(page).first().getAttribute('data-message-id')).toBe(await messages(second).first().getAttribute('data-message-id'));
    const savedId = await messages(page).first().getAttribute('data-message-id');
    for (const target of [page, second]) {
      await target.reload();
      await open(target);
      await expect(messages(target)).toHaveCount(1);
      await expect(messages(target).first()).toHaveAttribute('data-message-id', savedId!);
      await expect(messages(target).first().locator('.body')).toHaveText(literal);
      await expect(messages(target).locator('img, svg, script')).toHaveCount(0);
      expect(await target.locator('html').getAttribute('data-xss')).toBeNull();
    }

    const composer = second.getByLabel('Message', { exact: true });
    await composer.fill('First line'); await composer.press('Shift+Enter'); await composer.press('End');
    await composer.press('x');
    await composer.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await expect(messages(second)).toHaveCount(1);
    await composer.press('Enter');
    await expect(messages(page)).toHaveCount(2); await expect(messages(second)).toHaveCount(2);
    await expect(messages(page).last()).toContainText('Bob');
    await expect(messages(page).last().locator('.body')).toHaveText('First line\nx');

    for (let i = 0; i < 2; i++) {
      await second.getByRole('button', { name: 'Close conversation', exact: true }).click();
      await expect(second.locator('#channels-title')).toBeFocused();
      await open(second); await expect(messages(second)).toHaveCount(2 + i);
      await send(page, `After remount ${i}`);
      await expect(messages(second)).toHaveCount(3 + i);
      await expect(messages(second).last()).toContainText(`After remount ${i}`);
    }

    const project = process.env.E2E_COMPOSE_PROJECT ?? '';
    expect(['ci-chat', 'chat-e2e', 'handshake-verification']).toContain(project);
    const container = `${project}-api-1`;
    expect(execFileSync('docker', ['inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', container], { encoding: 'utf8' }).trim()).toBe(project);
    try {
      execFileSync('docker', ['stop', '--time', '2', container], { timeout: 15000, stdio: 'pipe' });
      await expect(second.getByText('Connection interrupted. Reconnecting…', { exact: true })).toBeVisible();
      await composer.fill('Draft kept during reconnect');
      await expect(second.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    } finally { execFileSync('docker', ['start', container], { timeout: 15000, stdio: 'pipe' }); }
    await expect(second.getByText(/^Live conversation ready\./)).toBeVisible({ timeout: 20000 });
    await expect(composer).toHaveValue('Draft kept during reconnect');
    await expect(second.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await expect(page.getByText(/^Live conversation ready\./)).toBeVisible();
    await composer.press('Enter');
    await expect(messages(page)).toHaveCount(5); await expect(messages(second)).toHaveCount(5);

    await send(page, 'Long message '.repeat(100));
    await expect(messages(second)).toHaveCount(6);
    for (const width of [320, 768, 1024, 1440]) {
      await second.setViewportSize({ width, height: 900 });
      expect(await second.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (width === 320 || width === 1440) await second.screenshot({ path: testInfo.outputPath(`conversation-${width}.png`), fullPage: true });
    }
    await second.getByRole('button', { name: `Leave ${name}`, exact: true }).click();
    await expect(second.getByRole('log')).toHaveCount(0);
    await expect(second.getByRole('button', { name: `Open chat ${name}`, exact: true })).toHaveCount(0);
    await send(page, 'Only Alice can receive this now');
    await expect(messages(page)).toHaveCount(7);
    await expect(second.getByText('Only Alice can receive this now', { exact: true })).toHaveCount(0);
  } finally { await other.close(); }
  expect(errors).toEqual([]);
  expect(violations).toEqual([]);
});
