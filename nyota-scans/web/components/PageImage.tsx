function hash(s: string) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/** Page de lecture. Les URL "placeholder:slug:chapitre:page" produisent une planche de démonstration. */
export function PageImage({ url, alt, accent = '#FFB627' }: { url: string; alt: string; accent?: string }) {
  if (!url.startsWith('placeholder:')) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="page-img" src={url} alt={alt} loading="lazy" />;
  }
  const [, slug, ch, n] = url.split(':');
  let seed = hash(url);
  const rnd = () => { seed = Math.imul(seed ^ (seed >>> 15), 2246822507) >>> 0; return (seed % 1000) / 1000; };
  const rows = 2 + Math.floor(rnd() * 2);
  const panels: { x: number; y: number; w: number; h: number }[] = [];
  const top = 30, gap = 14, H = 1000 - top * 2, W = 660 - 60;
  const rh = (H - gap * (rows - 1)) / rows;
  for (let r = 0; r < rows; r++) {
    const cols = 1 + Math.floor(rnd() * 2);
    const split = 0.35 + rnd() * 0.3;
    if (cols === 1) panels.push({ x: 30, y: top + r * (rh + gap), w: W, h: rh });
    else {
      const w1 = (W - gap) * split;
      panels.push({ x: 30, y: top + r * (rh + gap), w: w1, h: rh });
      panels.push({ x: 30 + w1 + gap, y: top + r * (rh + gap), w: W - gap - w1, h: rh });
    }
  }
  return (
    <svg className="page-img" viewBox="0 0 660 1000" role="img" aria-label={alt}>
      <rect width="660" height="1000" fill="#F5F3FF" />
      {panels.map((p, i) => (
        <g key={i}>
          <rect x={p.x} y={p.y} width={p.w} height={p.h} fill="#fff" stroke="#0B0A14" strokeWidth="5" />
          <rect x={p.x + 5} y={p.y + 5} width={p.w - 10} height={p.h - 10} fill={accent} opacity={0.15 + rnd() * 0.25} />
          <circle cx={p.x + p.w * (0.3 + rnd() * 0.4)} cy={p.y + p.h * 0.45} r={Math.min(p.w, p.h) * (0.12 + rnd() * 0.12)} fill="#241A6B" opacity=".75" />
          <path d={`M${p.x + 5} ${p.y + p.h - 5} L${p.x + p.w * 0.5} ${p.y + p.h * 0.65} L${p.x + p.w - 5} ${p.y + p.h - 5}Z`} fill="#0B0A14" opacity=".55" />
        </g>
      ))}
      <text x="330" y="990" textAnchor="middle" fontFamily="Arial, sans-serif" fontSize="18" fill="#0B0A14" opacity=".7">{slug} · ch. {ch} · p. {n} — planche de démonstration</text>
    </svg>
  );
}
