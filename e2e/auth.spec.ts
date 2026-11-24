import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

// Accounts are seeded by scripts/e2e-server.mjs: one per test per project, so parallel tests
// never share an address (a login code belongs to an address).
const account = (name: 'signin' | 'wrong' | 'perm-person' | 'perm-admin', project: string) =>
  `e2e-${name}-${project}@example.test`;

/** Read the newest code the development mailbox "sent" to an address (mock provider only). */
async function codeFor(request: APIRequestContext, email: string): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get('/api/dev/mailbox');
        const body = (await response.json()) as { messages: { to: string; text: string }[] };
        code = body.messages.find((m) => m.to === email)?.text.match(/\b(\d{6})\b/)?.[1];
        return code;
      },
      { message: `a code mailed to ${email}`, timeout: 15_000 },
    )
    .toBeTruthy();
  return code as string;
}

async function openLogin(page: Page, isMobile: boolean) {
  await page.goto('/');
  if (isMobile) await page.getByRole('button', { name: /open menu/i }).click();
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Sign in', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
}

async function signIn(page: Page, request: APIRequestContext, email: string, isMobile: boolean) {
  await openLogin(page, isMobile);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByLabel('Sign-in code')).toBeFocused();
  await page.getByLabel('Sign-in code').fill(await codeFor(request, email));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Hackathon Platform' })).toBeVisible();
}

test.describe('institutional email sign-in', () => {
  test('an approved employee signs in with an emailed code, keeps the session across a reload, and signs out', async ({
    page,
    request,
    isMobile,
  }, testInfo) => {
    const email = account('signin', testInfo.project.name);
    await signIn(page, request, email, isMobile);
    if (isMobile) await page.getByRole('button', { name: /open menu/i }).click();
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav).toContainText(email);

    // The session lives in an HttpOnly cookie, so scripts cannot read it.
    expect(await page.evaluate('document.cookie')).toBe('');
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name.endsWith('hackathon_session'));
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Strict' });

    await page.reload();
    if (isMobile) await page.getByRole('button', { name: /open menu/i }).click();
    await expect(nav).toContainText(email);

    await nav.getByRole('button', { name: 'Sign out' }).click();
    await expect(nav.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await page.reload();
    if (isMobile) await page.getByRole('button', { name: /open menu/i }).click();
    await expect(nav.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    // The old cookie is dead server-side as well, not merely removed from this browser.
    const after = await page.request.get('/api/auth/session');
    expect(after.status()).toBe(401);
  });

  test('a wrong code is refused, and an unapproved address learns nothing about the roster', async ({
    page,
    request,
    isMobile,
  }, testInfo) => {
    const approved = account('wrong', testInfo.project.name);
    await openLogin(page, isMobile);
    await page.getByLabel('Email address').fill(approved);
    await page.getByRole('button', { name: 'Email me a code' }).click();
    const real = await codeFor(request, approved);
    await page.getByLabel('Sign-in code').fill(real === '000000' ? '000001' : '000000');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('not valid or has expired');

    // An address that is not on the roster sees exactly the same confirmation...
    const stranger = `stranger-${testInfo.project.name}@example.test`;
    await page.getByRole('button', { name: 'Use a different email' }).click();
    await page.getByLabel('Email address').fill(stranger);
    await page.getByRole('button', { name: 'Email me a code' }).click();
    await expect(page.getByRole('status')).toContainText(`If ${stranger} is approved`);
    // ...but nothing is mailed to it.
    const mailbox = (await (await request.get('/api/dev/mailbox')).json()) as {
      messages: { to: string }[];
    };
    expect(mailbox.messages.some((m) => m.to === stranger)).toBe(false);
  });

  test('participants cannot reach admin endpoints; administrators can', async ({
    page,
    request,
    isMobile,
  }, testInfo) => {
    const project = testInfo.project.name;
    expect((await page.request.get('/api/admin/users')).status()).toBe(401);

    await signIn(page, request, account('perm-person', project), isMobile);
    expect((await page.request.get('/api/admin/users')).status()).toBe(403);

    await page.context().clearCookies();
    await signIn(page, request, account('perm-admin', project), isMobile);
    const response = await page.request.get('/api/admin/users');
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { users: { email: string }[] };
    expect(body.users.map((u) => u.email)).toContain(account('perm-person', project));
  });
});
