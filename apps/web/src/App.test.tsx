import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const health = (overrides: Record<string, unknown> = {}) => ({
  status: 'ok',
  service: 'hackathon-api',
  environment: 'development',
  version: 'dev',
  timestamp: '2026-11-24T10:00:00.000Z',
  checks: { database: 'ok' },
  ...overrides,
});

function stubFetch(handler: () => Promise<Response> | Response) {
  const fetchMock = vi.fn(() => Promise.resolve(handler()));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('application shell', () => {
  it('renders landmarks, a skip link and primary navigation', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: /skip to main content/i })).toHaveAttribute(
      'href',
      '#main',
    );
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'System status' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Hackathon Platform' }),
    ).toBeInTheDocument();
  });

  it('toggles the mobile menu with correct ARIA state and closes it on Escape', async () => {
    const user = userEvent.setup();
    renderAt('/');
    const button = screen.getByRole('button', { name: /open menu/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(button).toHaveAttribute('aria-controls', nav.id);
    expect(nav).toHaveAttribute('data-open', 'false');

    await user.click(button);
    expect(screen.getByRole('button', { name: /close menu/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(nav).toHaveAttribute('data-open', 'true');

    await user.keyboard('{Escape}');
    expect(nav).toHaveAttribute('data-open', 'false');
  });

  it('closes the menu and moves focus to main when navigating', async () => {
    const user = userEvent.setup();
    stubFetch(() => jsonResponse(health()));
    renderAt('/');
    await user.click(screen.getByRole('button', { name: /open menu/i }));
    await user.click(screen.getByRole('link', { name: 'System status' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'System status' })).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toHaveAttribute(
      'data-open',
      'false',
    );
    expect(screen.getByRole('main')).toHaveFocus();
    expect(document.title).toBe('System status · Hackathon Platform');
  });

  it('shows a not-found page for unknown routes', () => {
    renderAt('/nope/nothing');
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to the home page/i })).toHaveAttribute('href', '/');
  });
});

describe('status page', () => {
  it('shows a loading state and then the health report', async () => {
    stubFetch(() => jsonResponse(health()));
    renderAt('/status');
    expect(screen.getByRole('status')).toHaveTextContent('Checking');
    expect(await screen.findByText('All systems operational.')).toBeInTheDocument();
    expect(screen.getByText('development')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
  });

  it('shows a degraded warning when the API reports 503/degraded', async () => {
    stubFetch(() =>
      jsonResponse(health({ status: 'degraded', checks: { database: 'unavailable' } }), 503),
    );
    renderAt('/status');
    expect(await screen.findByText('Service degraded.')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });

  it('shows the API error message and request reference, and allows retry', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const fetchMock = stubFetch(() => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          {
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'The service is temporarily unavailable.',
              requestId: 'req-abc12345',
            },
          },
          503,
        );
      }
      return jsonResponse(health());
    });
    renderAt('/status');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The service is temporarily unavailable.');
    expect(alert).toHaveTextContent('req-abc12345');

    await user.click(screen.getByRole('button', { name: /check again/i }));
    expect(await screen.findByText('All systems operational.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('handles a network failure without leaking details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    renderAt('/status');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not reach the server.');
    expect(alert).not.toHaveTextContent('Failed to fetch');
  });

  it('rejects a payload that does not match the shared schema', async () => {
    stubFetch(() => jsonResponse({ status: 'ok', surprise: true }));
    renderAt('/status');
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/unexpected response/i),
    );
  });

  it('handles a non-JSON response', async () => {
    stubFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    renderAt('/status');
    expect(await screen.findByRole('alert')).toHaveTextContent(/unreadable response/i);
  });
});
