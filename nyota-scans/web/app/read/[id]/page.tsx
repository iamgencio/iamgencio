'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Chapter } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { PageImage } from '@/components/PageImage';

export default function Reader({ params }: { params: { id: string } }) {
  const { user, ready } = useAuth();
  const [ch, setCh] = useState<Chapter | null>(null);
  const [err, setErr] = useState('');
  const [current, setCurrent] = useState(1);
  const lastSent = useRef(0);

  useEffect(() => {
    if (!ready) return;
    setCh(null); setErr(''); setCurrent(1); lastSent.current = 0;
    api<Chapter>(`/chapters/${params.id}`).then(setCh).catch((e: ApiError) => setErr(e.message));
    window.scrollTo(0, 0);
  }, [params.id, ready, user?.premium]);

  useEffect(() => {
    if (!ch || !user) return;
    const els = document.querySelectorAll<HTMLElement>('[data-page]');
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) setCurrent(Number((e.target as HTMLElement).dataset.page));
    }, { rootMargin: '-45% 0px -45% 0px' });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ch, user]);

  useEffect(() => {
    if (!ch || !user || ch.locked || current === lastSent.current) return;
    const t = setTimeout(() => { lastSent.current = current; api(`/chapters/${ch.id}/progress`, { method: 'POST', body: { page: current } }).catch(() => {}); }, 800);
    return () => clearTimeout(t);
  }, [current, ch, user]);

  if (err) return <div className="empty">{err}</div>;
  if (!ch) return <div className="empty">Chargement…</div>;

  const nav = (
    <div className="reader-nav">
      {ch.prev_id ? <Link className="btn btn-ghost btn-sm" href={`/read/${ch.prev_id}`}>← Précédent</Link> : <span />}
      <Link className="link" href={`/series/${ch.series_slug}`}>{ch.series_title} · Chapitre {Number(ch.number)}</Link>
      {ch.next_id ? <Link className="btn btn-gold btn-sm" href={`/read/${ch.next_id}`}>Suivant →</Link> : <span />}
    </div>
  );

  return (
    <div className="reader" style={{ ['--accent' as string]: ch.accent }}>
      {nav}
      <div className="reader-pages">
        {ch.pages.map((p) => (
          <div key={p.position} data-page={p.position}><PageImage url={p.image_url} alt={`${ch.series_title} — chapitre ${Number(ch.number)}, page ${p.position}`} accent={ch.accent} /></div>
        ))}
      </div>
      {ch.locked && (
        <div className="paywall">
          <h2>★ Chapitre Premium</h2>
          <p>Vous avez lu l&apos;aperçu. Passez Premium pour lire la suite ({ch.total_pages} pages) et tous les chapitres exclusifs — payez par Mobile Money.</p>
          <div className="hero-actions">
            <Link href="/premium" className="btn btn-gold">Voir les formules</Link>
            {!user && <Link href="/login" className="btn btn-ghost">J&apos;ai déjà un compte</Link>}
          </div>
        </div>
      )}
      {nav}
      {!ch.locked && <div className="reader-progress" aria-hidden>{current} / {ch.total_pages}</div>}
    </div>
  );
}
