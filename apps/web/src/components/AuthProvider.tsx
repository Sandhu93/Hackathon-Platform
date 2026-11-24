import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { SessionUser } from '@hackathon/shared';
import { fetchSessionUser, signOut as signOutRequest } from '../lib/auth-api';

type AuthState =
  { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: SessionUser };

interface AuthContextValue {
  state: AuthState;
  /** Call after a successful sign-in so the header and guards update without a reload. */
  setUser: (user: SessionUser) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchSessionUser().then(
      (user) => {
        if (!cancelled)
          setState(user ? { status: 'authenticated', user } : { status: 'anonymous' });
      },
      // A failed lookup must never look like "signed in"; treat it as signed out.
      () => {
        if (!cancelled) setState({ status: 'anonymous' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const setUser = useCallback(
    (user: SessionUser) => setState({ status: 'authenticated', user }),
    [],
  );

  const signOut = useCallback(async () => {
    try {
      await signOutRequest();
    } catch {
      // Offline or server error: still drop the local signed-in view. The server-side revocation
      // is what really ends the session; "sign out everywhere" is the fallback if it did not land.
    }
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo(() => ({ state, setUser, signOut }), [state, setUser, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
