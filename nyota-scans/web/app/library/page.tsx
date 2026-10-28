'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, type SeriesCard } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Card } from '@/components/Card';
import { Cover } from '@/components/Cover';

type Hist = { id: number; slug: string; title: string; type: string; cover_url: string | null; accent: string; chapter_id: number; number: string; page: number };

export default function Library() {
  const { user, ready } = useAuth();
  const [data, setData] = useState<{ favorites: SeriesCard[]; history: Hist[] } | null>(null);
  useEffect(() => { if (user) api<{ favorites: SeriesCard[]; history: Hist[] }>('/library').then(setData).catch(() => {}); }, [user]);

  if (!ready) return <div className="empty">Chargement…</div>;
  if (!user) return <div className="empty">Connectez-vous pour retrouver votre bibliothèque. <Link href="/login" className="btn btn-gold">Connexion</Link></div>;
  if (!data) return <div className="empty">Chargement…</div>;
  const seen = new Set<number>();
  const resume = data.history.filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)));
  return (
    <div className="page">
      <h1>Ma bibliothèque</h1>
      <h2>Reprendre la lecture</h2>
      {resume.length === 0 ? <p className="muted">Rien en cours. <Link href="/browse">Explorer le catalogue</Link></p> : (
        <div className="row-scroll">
          {resume.map((h) => (
            <Link key={h.id} href={`/read/${h.chapter_id}`} className="card">
              <div className="card-cover"><Cover s={{ ...h, author: '' }} /></div>
              <div className="card-title">{h.title}</div>
              <div className="card-sub">Chap. {Number(h.number)} · page {h.page}</div>
            </Link>
          ))}
        </div>
      )}
      <h2>Mes favoris</h2>
      {data.favorites.length === 0 ? <p className="muted">Ajoutez des séries à votre bibliothèque depuis leur page.</p> : <div className="grid">{data.favorites.map((s) => <Card key={s.id} s={s} />)}</div>}
    </div>
  );
}
