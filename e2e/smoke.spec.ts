import { expect, test } from '@playwright/test';

test.describe('smoke', () => {
  test('home page renders the shell without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/');
    await expect(page).toHaveTitle(/Home · Hackathon Platform/);
    await expect(page.getByRole('heading', { level: 1, name: 'Hackathon Platform' })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('static assets are served with security headers', async ({ request }) => {
    const response = await request.get('/');
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  test('health endpoint is reachable through the Worker', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      status: 'ok',
      service: 'hackathon-api',
      checks: { database: 'ok' },
    });
    expect(response.headers()['x-request-id']).toBeTruthy();
  });

  test('unknown API routes return the standard JSON 404', async ({ request }) => {
    const response = await request.get('/api/nope');
    expect(response.status()).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  test('user can open the status page from the navigation', async ({ page, isMobile }) => {
    await page.goto('/');
    if (isMobile) await page.getByRole('button', { name: /open menu/i }).click();
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'System status', exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'System status' })).toBeVisible();
    await expect(page.getByText('All systems operational.')).toBeVisible();
  });

  test('deep links and unknown pages fall back to the SPA', async ({ page }) => {
    await page.goto('/status');
    await expect(page.getByRole('heading', { level: 1, name: 'System status' })).toBeVisible();
    await page.goto('/this/page/does/not/exist');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  });

  test('skip link is the first focusable element and jumps to main', async ({ page, isMobile }) => {
    test.skip(isMobile, 'keyboard navigation is a desktop concern');
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: /skip to main content/i });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });

  test('mobile menu opens and closes', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile layout only');
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav).toBeHidden();
    await page.getByRole('button', { name: /open menu/i }).click();
    await expect(nav).toBeVisible();
    await page.getByRole('button', { name: /close menu/i }).click();
    await expect(nav).toBeHidden();
  });

  test('desktop shows the navigation inline without a menu button', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop layout only');
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('button', { name: /menu/i })).toBeHidden();
  });
});
