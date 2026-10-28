import Link from 'next/link';
import { api, TYPE_LABEL, compact, type SeriesCard } from '@/lib/api';
import { Cover } from '@/components/Cover';
import { Row } from '@/components/Card';

export const dynamic = 'force-dynamic';

type Home = { featured: SeriesCard[]; rows: { key: string; title: string; items: SeriesCard[] }[] };

export default async function HomePage() {
  const data = await api<Home>('/home').catch(() => null);
  if (!data) return <div className="empty">Le catalogue est momentanément indisponible. Réessayez dans un instant.</div>;
  const hero = data.featured[0];
  return (
    <>
      {hero && (
        <section className="hero" style={{ ['--accent' as string]: hero.accent }}>
          <div className="hero-art"><Cover s={hero} priority /></div>
          <div className="hero-body">
            <span className="eyebrow">À la une · {TYPE_LABEL[hero.type]}{hero.country ? ` · ${hero.country}` : ''}</span>
            <h1>{hero.title}</h1>
            <p className="hero-meta">{hero.author} · {hero.chapter_count} chapitres · {compact(hero.views)} lectures</p>
            <div className="chips">{hero.genres.map((g) => <span key={g.slug} className="chip">{g.name}</span>)}</div>
            <div className="hero-actions">
              <Link href={`/series/${hero.slug}`} className="btn btn-gold">Lire maintenant</Link>
              <Link href="/browse" className="btn btn-ghost">Explorer le catalogue</Link>
            </div>
          </div>
        </section>
      )}
      <Row title="À la une" items={data.featured.slice(1)} />
      {data.rows.map((r) => <Row key={r.key} title={r.title} items={r.items} />)}
      <section className="cta">
        <h2>Vous créez des histoires ?</h2>
        <p>Publiez votre BD ou votre manga sur Nyota Scans et touchez des lecteurs partout en Afrique et dans le monde.</p>
        <Link href="/register?role=creator" className="btn btn-gold">Devenir créateur</Link>
      </section>
    </>
  );
}
