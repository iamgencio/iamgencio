import Link from 'next/link';
import { api, TYPE_LABEL, type Genre, type SeriesCard } from '@/lib/api';
import { Card } from '@/components/Card';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Catalogue' };

type Res = { items: SeriesCard[]; total: number; page: number; pages: number };

export default async function Browse({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const qs = new URLSearchParams();
  for (const k of ['type', 'genre', 'q', 'sort', 'page']) if (searchParams[k]) qs.set(k, searchParams[k]!);
  const [res, g] = await Promise.all([
    api<Res>('/series?' + qs).catch(() => null),
    api<{ genres: Genre[] }>('/genres').catch(() => ({ genres: [] })),
  ]);
  const href = (patch: Record<string, string | undefined>) => {
    const n = new URLSearchParams(qs);
    n.delete('page');
    for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k);
    return '/browse?' + n;
  };
  const types = Object.entries(TYPE_LABEL);
  return (
    <div className="page">
      <h1>{searchParams.q ? `Résultats pour « ${searchParams.q} »` : 'Catalogue'}</h1>
      <div className="filters">
        <div className="chips">
          <Link href={href({ type: undefined })} className={`chip ${!searchParams.type ? 'on' : ''}`}>Tout</Link>
          {types.map(([k, v]) => <Link key={k} href={href({ type: k })} className={`chip ${searchParams.type === k ? 'on' : ''}`}>{v}</Link>)}
        </div>
        <div className="chips">
          {g.genres.map((x) => <Link key={x.slug} href={href({ genre: searchParams.genre === x.slug ? undefined : x.slug })} className={`chip ${searchParams.genre === x.slug ? 'on' : ''}`}>{x.name}</Link>)}
        </div>
        <div className="chips">
          {[['popular', 'Populaires'], ['new', 'Récents'], ['az', 'A–Z']].map(([k, v]) => (
            <Link key={k} href={href({ sort: k })} className={`chip ${(searchParams.sort || 'popular') === k ? 'on' : ''}`}>{v}</Link>
          ))}
        </div>
      </div>
      {!res ? <div className="empty">Catalogue indisponible.</div> : res.items.length === 0 ? <div className="empty">Aucune série trouvée.</div> : (
        <>
          <p className="muted">{res.total} série{res.total > 1 ? 's' : ''}</p>
          <div className="grid">{res.items.map((s) => <Card key={s.id} s={s} />)}</div>
          {res.pages > 1 && (
            <div className="pager">
              {Array.from({ length: res.pages }, (_, i) => i + 1).map((p) => (
                <Link key={p} href={href({ page: String(p) })} className={`chip ${p === res.page ? 'on' : ''}`}>{p}</Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
