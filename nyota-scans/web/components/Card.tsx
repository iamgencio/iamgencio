import Link from 'next/link';
import { Cover } from './Cover';
import { TYPE_LABEL, type SeriesCard } from '@/lib/api';

export function Card({ s }: { s: SeriesCard }) {
  return (
    <Link href={`/series/${s.slug}`} className="card" title={s.title}>
      <div className="card-cover">
        <Cover s={s} />
        <span className={`badge badge-${s.type}`}>{TYPE_LABEL[s.type]}</span>
      </div>
      <div className="card-title">{s.title}</div>
      <div className="card-sub">{s.author}</div>
    </Link>
  );
}

export function Row({ title, items }: { title: string; items: SeriesCard[] }) {
  if (!items.length) return null;
  return (
    <section className="row">
      <h2>{title}</h2>
      <div className="row-scroll">{items.map((s) => <Card key={s.id} s={s} />)}</div>
    </section>
  );
}
