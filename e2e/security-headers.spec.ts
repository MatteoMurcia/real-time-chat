import { expect, test } from '@playwright/test';

test('serves security headers on documents, assets, API errors and polling without blocking Angular', async ({ page, request }) => {
  const violations: string[] = [], errors: string[] = [];
  await page.exposeFunction('recordCspViolation', (directive: string) => violations.push(directive));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', event => {
      void (window as unknown as { recordCspViolation: (directive: string) => Promise<void> }).recordCspViolation(event.violatedDirective);
    });
  });
  page.on('pageerror', error => errors.push(error.message));
  const document = await page.goto('/login');
  expect(document?.status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.locator('script:not([src])')).toHaveCount(0);
  const asset = await page.locator('script[src]').first().getAttribute('src');
  expect(asset).toBeTruthy();
  const origin = process.env.E2E_BASE_URL!;
  for (const path of ['/', '/login', asset!, '/api/health/live', '/api/channels', '/api/missing', '/socket.io/?EIO=4&transport=polling']) {
    const response = await request.get(path, { headers: { origin } });
    const headers = response.headers();
    expect(headers['x-content-type-options'], path).toBe('nosniff');
    expect(headers['x-frame-options'], path).toBe('DENY');
    expect(headers['referrer-policy'], path).toBe('same-origin');
    const policy = headers['content-security-policy'];
    expect(policy, path).toBe("default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
    if (path === '/' || path === '/login' || path === asset) expect(headers['cache-control'], path).toBe('no-cache');
    if (path === '/api/channels' || path === '/api/missing') expect(headers['cache-control'], path).toBe('no-store');
    if (path === '/api/channels') expect(response.status()).toBe(401);
    if (path === '/api/missing') expect(response.status()).toBe(404);
    if (path.startsWith('/socket.io/')) expect(response.status()).toBe(200);
  }
  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
});
