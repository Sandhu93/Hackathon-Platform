import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { urlOf } from './test/url';

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ada@example.test',
  displayName: 'Ada',
  role: 'participant',
};

const session = { expiresAt: '2026-12-01T00:00:00.000Z' };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const apiError = (code: string, message: string, status: number, headers = {}) =>
  json({ error: { code, message, requestId: 'req-1' } }, status, headers);

interface Server {
  signedIn: boolean;
  requestCode: () => Response;
  verifyCode: (body: { email: string; code: string }) => Response;
}

/** A tiny in-memory stand-in for the API, so the UI is tested against the real contracts. */
function mockServer(overrides: Partial<Server> = {}) {
  const server: Server = {
    signedIn: false,
    requestCode: () => json({ status: 'accepted', resendAfterSeconds: 60 }, 202),
    verifyCode: () => json({ user, session }),
    ...overrides,
  };
  const calls: { path: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = urlOf(input);
      const method = init?.method ?? 'GET';
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ path, method, body });
      if (path === '/api/auth/session') {
        return Promise.resolve(
          server.signedIn
            ? json({ user, session })
            : apiError('UNAUTHENTICATED', 'Sign in required.', 401),
        );
      }
      if (path === '/api/auth/otp/request') return Promise.resolve(server.requestCode());
      if (path === '/api/auth/otp/verify') {
        const response = server.verifyCode(body as { email: string; code: string });
        if (response.status === 200) server.signedIn = true;
        return Promise.resolve(response);
      }
      if (path === '/api/auth/logout') {
        server.signedIn = false;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }),
  );
  return { server, calls };
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const nav = () => screen.getByRole('navigation', { name: 'Primary' });

describe('sign-in flow', () => {
  beforeEach(() => {
    mockServer();
  });

  it('offers "Sign in" in the header when nobody is signed in', async () => {
    renderAt('/');
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('signs in with an emailed code and shows the account in the header', async () => {
    const { calls } = mockServer();
    const person = userEvent.setup();
    renderAt('/login');

    await person.type(await screen.findByLabelText('Email address'), '  Ada@Example.TEST ');
    await person.click(screen.getByRole('button', { name: 'Email me a code' }));

    // Wording is identical for every address: it must not reveal whether the account exists.
    expect(await screen.findByRole('status')).toHaveTextContent(
      'If ada@example.test is approved for this platform',
    );
    expect(calls.find((c) => c.path === '/api/auth/otp/request')?.body).toEqual({
      email: 'ada@example.test',
    });
    const codeInput = screen.getByLabelText('Sign-in code');
    expect(codeInput).toHaveFocus();
    expect(codeInput).toHaveAttribute('autocomplete', 'one-time-code');

    await person.type(codeInput, '123 456');
    await person.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(nav()).toHaveTextContent('ada@example.test'));
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/auth/otp/verify')?.body).toEqual({
      email: 'ada@example.test',
      code: '123456',
    });
    // The login page leaves once signed in.
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('validates the email and the code locally without calling the API', async () => {
    const { calls } = mockServer();
    const person = userEvent.setup();
    renderAt('/login');
    await person.type(await screen.findByLabelText('Email address'), 'not-an-email');
    await person.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address.');
    expect(calls.some((c) => c.path === '/api/auth/otp/request')).toBe(false);

    await person.clear(screen.getByLabelText('Email address'));
    await person.type(screen.getByLabelText('Email address'), 'ada@example.test');
    await person.click(screen.getByRole('button', { name: 'Email me a code' }));
    await person.type(await screen.findByLabelText('Sign-in code'), '12ab');
    await person.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the 6-digit code');
    expect(calls.some((c) => c.path === '/api/auth/otp/verify')).toBe(false);
  });

  it('shows one generic message for a wrong, used or expired code and stays on the code step', async () => {
    mockServer({
      verifyCode: () => apiError('INVALID_OR_EXPIRED_CODE', 'Invalid or expired code.', 401),
    });
    const person = userEvent.setup();
    renderAt('/login');
    await person.type(await screen.findByLabelText('Email address'), 'ada@example.test');
    await person.click(screen.getByRole('button', { name: 'Email me a code' }));
    await person.type(await screen.findByLabelText('Sign-in code'), '000000');
    await person.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not valid or has expired');
    expect(screen.getByLabelText('Sign-in code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('explains throttling in minutes using Retry-After', async () => {
    mockServer({
      requestCode: () =>
        apiError('RATE_LIMITED', 'Too many requests.', 429, { 'retry-after': '1500' }),
    });
    const person = userEvent.setup();
    renderAt('/login');
    await person.type(await screen.findByLabelText('Email address'), 'ada@example.test');
    await person.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('about 25 minutes');
  });

  it('shows a calm message when sign-in is unavailable', async () => {
    mockServer({
      requestCode: () => apiError('SERVICE_UNAVAILABLE', 'internal detail', 503),
    });
    const person = userEvent.setup();
    renderAt('/login');
    await person.type(await screen.findByLabelText('Email address'), 'ada@example.test');
    await person.click(screen.getByRole('button', { name: 'Email me a code' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('temporarily unavailable');
    expect(alert).not.toHaveTextContent('internal detail');
  });

  it('can request a new code or go back to change the address', async () => {
    const { calls } = mockServer();
    const person = userEvent.setup();
    renderAt('/login');
    await person.type(await screen.findByLabelText('Email address'), 'ada@example.test');
    await person.click(screen.getByRole('button', { name: 'Email me a code' }));
    await person.click(await screen.findByRole('button', { name: 'Send a new code' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/api/auth/otp/request')).toHaveLength(2),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('We sent a new code.');
    await person.click(screen.getByRole('button', { name: 'Use a different email' }));
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
  });
});

describe('existing session', () => {
  it('shows the signed-in user, redirects /login to home, and signs out', async () => {
    const { calls } = mockServer({ signedIn: true });
    const person = userEvent.setup();
    renderAt('/login');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Hackathon Platform' }),
    ).toBeInTheDocument();
    expect(nav()).toHaveTextContent('ada@example.test');

    await person.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/auth/logout' && c.method === 'POST')).toBe(true);
  });

  it('still looks signed out locally if the logout request fails', async () => {
    mockServer({ signedIn: true });
    const person = userEvent.setup();
    renderAt('/');
    await screen.findByRole('button', { name: 'Sign out' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await person.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('treats a failed session lookup as signed out, never as signed in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    renderAt('/');
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });
});
