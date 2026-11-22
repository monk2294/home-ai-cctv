import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiRequestError } from '../api/client';

type AuthState =
  | { status: 'checking' }
  | { status: 'anonymous' }
  | { status: 'authenticated' };

interface AuthContextValue {
  state: AuthState;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Сброс локальной сессии при 401 без обращения к серверу. */
  markAnonymous: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'checking' });

  useEffect(() => {
    let cancelled = false;
    api
      .listCameras()
      .then(() => {
        if (!cancelled) setState({ status: 'authenticated' });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          setState({ status: 'anonymous' });
        } else {
          // Сеть или сервер недоступны — считаем анонимным, экраны покажут ошибку.
          setState({ status: 'anonymous' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (password: string) => {
    await api.login(password);
    setState({ status: 'authenticated' });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setState({ status: 'anonymous' });
    }
  }, []);

  const markAnonymous = useCallback(() => {
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo(
    () => ({ state, login, logout, markAnonymous }),
    [state, login, logout, markAnonymous],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth вне AuthProvider');
  }
  return ctx;
}
