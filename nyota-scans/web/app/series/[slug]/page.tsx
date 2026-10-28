import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api, TYPE_LABEL, compact, type SeriesDetail } from '@/lib/api';
import { Cover } from '@/components/Cover';
import { SeriesActions } from './actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { slug: string } }) {
  const s = await api<SeriesDetail>(`/series/${params.slug}`).catch(() => null);
  return { title: s?.title ?? 'Série', description: s?.synopsis };
}

export default async function SeriesPage({ params }: { params: { slug: string } }) {
  const s = await api<SeriesDetail>(`/series/${params.slug}`).catch(() => null);
  if (!s) notFound();
  const first = [...s.chapters].reverse()[0];
  return (
    <div className="page" style={{ ['--accent' as string]: s.accent }}>
      <div className="detail">
        <div className="detail-cover"><Cover s={s} priority /></div>
        <div>
          <span className="eyebrow">{TYPE_LABEL[s.type]}{s.country ? ` · ${s.country}` : ''} · {s.status === 'completed' ? 'Terminé' : s.status === 'hiatus' ? 'En pause' : 'En cours'}</span>
          <h1>{s.title}</h1>
          <p className="hero-meta">par {s.author} · {compact(s.views)} lectures</p>
          <div className="chips">{s.genres.map((g) => <Link key={g.slug} href={`/browse?genre=${g.slug}`} className="chip">{g.name}</Link>)}</div>
          <p className="synopsis">{s.synopsis}</p>
          <SeriesActions seriesId={s.id} firstChapterId={first?.id} initialFav={s.is_favorite} />
        </div>
      </div>
      <h2>Chapitres ({s.chapters.length})</h2>
      <ul className="chapters">
        {s.chapters.map((c) => (
          <li key={c.id}>
            <Link href={`/read/${c.id}`}>
              <span>Chapitre {Number(c.number)}{c.title && c.title !== `Chapitre ${Number(c.number)}` ? ` — ${c.title}` : ''}</span>
              <span className="muted">{c.is_premium ? <span className="pill">★ Premium</span> : 'Gratuit'} · {new Date(c.published_at).toLocaleDateString('fr-FR')}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
