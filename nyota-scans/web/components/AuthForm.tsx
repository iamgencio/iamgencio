'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, type User } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { LogoMark } from './Logo';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const { login } = useAuth();
  const router = useRouter();
  const sp = useSearchParams();
  const creator = sp.get('role') === 'creator';
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const r = await api<{ token: string; user: User }>(`/auth/${mode}`, { method: 'POST', body: mode === 'register' ? { ...f, role: creator ? 'creator' : 'reader' } : f });
      await login(r.token);
      router.push(r.user.role === 'creator' ? '/creator' : sp.get('next') || '/');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <form className="auth" onSubmit={submit}>
      <LogoMark size={56} />
      <h1>{mode === 'login' ? 'Bon retour parmi les étoiles' : creator ? 'Devenez créateur Nyota' : 'Rejoignez Nyota Scans'}</h1>
      {mode === 'register' && <label>Nom<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" /></label>}
      <label>Email<input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" /></label>
      <label>Mot de passe<input required type="password" minLength={mode === 'register' ? 8 : undefined} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
      {err && <p className="error" role="alert">{err}</p>}
      <button className="btn btn-gold" disabled={busy}>{busy ? '…' : mode === 'login' ? 'Se connecter' : 'Créer mon compte'}</button>
      <p className="muted">{mode === 'login' ? <>Pas de compte ? <Link href="/register">S&apos;inscrire</Link></> : <>Déjà inscrit ? <Link href="/login">Se connecter</Link></>}</p>
    </form>
  );
}
