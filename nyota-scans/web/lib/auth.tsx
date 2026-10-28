'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, TOKEN_KEY, type User } from './api';

type Ctx = { user: User | null; ready: boolean; login: (token: string) => Promise<void>; logout: () => void; refresh: () => Promise<void> };
const AuthCtx = createContext<Ctx>({ user: null, ready: false, login: async () => {}, logout: () => {}, refresh: async () => {} });
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!localStorage.getItem(TOKEN_KEY)) { setUser(null); setReady(true); return; }
    try { setUser((await api<{ user: User }>('/me')).user); }
    catch { localStorage.removeItem(TOKEN_KEY); setUser(null); }
    setReady(true);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = async (token: string) => { localStorage.setItem(TOKEN_KEY, token); await refresh(); };
  const logout = () => { localStorage.removeItem(TOKEN_KEY); setUser(null); };
  return <AuthCtx.Provider value={{ user, ready, login, logout, refresh }}>{children}</AuthCtx.Provider>;
}
