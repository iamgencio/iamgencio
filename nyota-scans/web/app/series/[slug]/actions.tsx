'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, type SeriesDetail } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export function SeriesActions({ seriesId, firstChapterId, initialFav }: { seriesId: number; firstChapterId?: number; initialFav: boolean }) {
  const { user, ready } = useAuth();
  const [fav, setFav] = useState(initialFav);
  const [resume, setResume] = useState<{ chapter_id: number; page: number } | null>(null);

  useEffect(() => {
    if (!user) return;
    api<{ favorites: { id: number }[]; history: { id: number; chapter_id: number; page: number }[] }>('/library').then((l) => {
      setFav(l.favorites.some((f) => f.id === seriesId));
      const h = l.history.find((x) => x.id === seriesId);
      setResume(h ? { chapter_id: h.chapter_id, page: h.page } : null);
    }).catch(() => {});
  }, [user, seriesId]);

  const toggle = async () => {
    if (!user) { window.location.href = '/login'; return; }
    const next = !fav;
    setFav(next);
    try { await api(`/favorites/${seriesId}`, { method: next ? 'POST' : 'DELETE' }); } catch { setFav(!next); }
  };

  return (
    <div className="hero-actions">
      {resume ? (
        <Link href={`/read/${resume.chapter_id}`} className="btn btn-gold">Reprendre la lecture</Link>
      ) : firstChapterId ? (
        <Link href={`/read/${firstChapterId}`} className="btn btn-gold">Commencer à lire</Link>
      ) : null}
      <button className="btn btn-ghost" onClick={toggle} disabled={!ready} aria-pressed={fav}>{fav ? '✓ Dans ma bibliothèque' : '+ Ma bibliothèque'}</button>
    </div>
  );
}
