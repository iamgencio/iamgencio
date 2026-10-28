'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Logo } from './Logo';
import { useAuth } from '@/lib/auth';

export function Header() {
  const { user, ready, logout } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  return (
    <header className="header">
      <Link href="/" aria-label="Nyota Scans — accueil"><Logo /></Link>
      <nav className="nav">
        <Link href="/browse">Catalogue</Link>
        <Link href="/browse?type=bd_africaine">BD africaines</Link>
        <Link href="/browse?type=manga">Mangas</Link>
        <Link href="/browse?type=manhwa">Manhwas</Link>
      </nav>
      <form className="search" onSubmit={(e) => { e.preventDefault(); router.push(`/browse?q=${encodeURIComponent(q)}`); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher une série, un auteur…" aria-label="Rechercher" />
      </form>
      <div className="user">
        {!ready ? null : user ? (
          <>
            {!user.premium && <Link href="/premium" className="btn btn-gold btn-sm">Passer Premium</Link>}
            {user.premium && <span className="pill">★ Premium</span>}
            <Link href="/library" className="link">Ma bibliothèque</Link>
            {user.role !== 'reader' && <Link href={user.role === 'admin' ? '/admin' : '/creator'} className="link">{user.role === 'admin' ? 'Admin' : 'Espace créateur'}</Link>}
            <button className="link" onClick={() => { logout(); router.push('/'); }}>Déconnexion</button>
          </>
        ) : (
          <>
            <Link href="/login" className="link">Connexion</Link>
            <Link href="/register" className="btn btn-gold btn-sm">S&apos;inscrire</Link>
          </>
        )}
      </div>
    </header>
  );
}
