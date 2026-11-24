import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';

const NAV_ITEMS = [
  { to: '/', label: 'Home', end: true },
  { to: '/status', label: 'System status', end: false },
] as const;

const TITLES: Record<string, string> = {
  '/': 'Home',
  '/status': 'System status',
};

export function Layout() {
  const location = useLocation();
  // The menu is "open" only for the path it was opened on, so navigating closes it without an effect.
  const [menu, setMenu] = useState({ open: false, path: location.pathname });
  const menuOpen = menu.open && menu.path === location.pathname;
  const setMenuOpen = (open: boolean) => setMenu({ open, path: location.pathname });
  const navId = useId();
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  // On client-side navigation: close the mobile menu, set the page title and move focus to
  // <main> so screen-reader and keyboard users land at the new content.
  useEffect(() => {
    const title = TITLES[location.pathname] ?? 'Page not found';
    document.title = `${title} · Hackathon Platform`;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu({ open: false, path: location.pathname });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen, location.pathname]);

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="site-header">
        <div className="site-header__inner">
          <NavLink to="/" className="brand" aria-label="Hackathon Platform, home">
            Hackathon Platform
          </NavLink>
          <button
            type="button"
            className="menu-button"
            aria-expanded={menuOpen}
            aria-controls={navId}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <span className="menu-button__bars" aria-hidden="true" />
            <span className="visually-hidden">{menuOpen ? 'Close menu' : 'Open menu'}</span>
          </button>
          <nav id={navId} aria-label="Primary" className="primary-nav" data-open={menuOpen}>
            <ul>
              {NAV_ITEMS.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.end}>
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main id="main" ref={mainRef} tabIndex={-1} className="site-main">
        <Outlet />
      </main>
      <footer className="site-footer">
        <p>Internal hackathon platform</p>
      </footer>
    </div>
  );
}
