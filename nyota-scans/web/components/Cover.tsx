import type { SeriesCard } from '@/lib/api';

function hash(s: string) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

function wrap(title: string, max = 14): string[] {
  const out: string[] = []; let line = '';
  for (const w of title.split(' ')) {
    if ((line + ' ' + w).trim().length > max && line) { out.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) out.push(line);
  return out.slice(0, 4);
}

/** Couverture : image si fournie, sinon affiche générée (dégradé + étoile + titre). */
export function Cover({ s, priority }: { s: Pick<SeriesCard, 'title' | 'slug' | 'accent' | 'cover_url' | 'author'>; priority?: boolean }) {
  if (s.cover_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="cover" src={s.cover_url} alt={s.title} loading={priority ? 'eager' : 'lazy'} />;
  }
  const h = hash(s.slug);
  const a = s.accent || '#FFB627';
  const angle = h % 360;
  const lines = wrap(s.title.toUpperCase());
  return (
    <svg className="cover" viewBox="0 0 300 450" role="img" aria-label={s.title}>
      <defs>
        <linearGradient id={`c${h}`} gradientTransform={`rotate(${angle} .5 .5)`}>
          <stop offset="0" stopColor={a} stopOpacity=".95" /><stop offset=".55" stopColor="#241A6B" /><stop offset="1" stopColor="#0B0A14" />
        </linearGradient>
      </defs>
      <rect width="300" height="450" fill={`url(#c${h})`} />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <circle key={i} cx={(h >> i) % 300} cy={((h >> (i + 3)) % 200) + 20} r={1 + (i % 3)} fill="#fff" opacity=".6" />
      ))}
      <path transform={`translate(${150 - 70} 60) scale(1.17)`} d="M60 0C63 36 70 47 120 60C70 73 63 84 60 120C57 84 50 73 0 60C50 47 57 36 60 0Z" fill="#fff" opacity=".22" />
      <rect x="14" y="14" width="272" height="422" rx="10" fill="none" stroke="#fff" strokeOpacity=".25" strokeWidth="2" />
      {lines.map((l, i) => (
        <text key={i} x="26" y={300 + i * 34} fontFamily="Arial Black, Arial, sans-serif" fontWeight={900} fontSize="30" fill="#fff" letterSpacing="1">{l}</text>
      ))}
      <text x="26" y="425" fontFamily="Arial, sans-serif" fontWeight={700} fontSize="14" fill="#fff" opacity=".85" letterSpacing="3">{s.author.toUpperCase().slice(0, 24)}</text>
    </svg>
  );
}
