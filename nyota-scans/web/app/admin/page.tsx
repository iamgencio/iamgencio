'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, fcfa, TYPE_LABEL, type SeriesType } from '@/lib/api';
import { useAuth } from '@/lib/auth';

type Stats = { users: number; series: number; pending: number; subscribers: number; revenue_xof: number };
type Row = { id: number; slug: string; title: string; author: string; type: SeriesType; publish_status: string; creator: string | null };

export default function Admin() {
  const { user, ready } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const load = useCallback(() => {
    api<Stats>('/admin/stats').then(setStats).catch(() => {});
    api<{ items: Row[] }>('/admin/series').then((r) => setRows(r.items)).catch(() => {});
  }, []);
  useEffect(() => { if (user?.role === 'admin') load(); }, [user, load]);

  if (!ready) return <div className="empty">Chargement…</div>;
  if (user?.role !== 'admin') return <div className="empty">Accès réservé à l&apos;équipe Starlight Network. <Link href="/login" className="btn btn-gold">Connexion</Link></div>;

  const set = async (id: number, publish_status: string, is_featured?: boolean) => {
    await api(`/admin/series/${id}/status`, { method: 'POST', body: { publish_status, is_featured } }); load();
  };
  return (
    <div className="page">
      <h1>Administration</h1>
      {stats && (
        <div className="stats">
          {[['Utilisateurs', stats.users], ['Séries publiées', stats.series], ['À valider', stats.pending], ['Abonnés actifs', stats.subscribers], ['Revenus', fcfa(stats.revenue_xof)]].map(([k, v]) => (
            <div key={String(k)} className="stat"><span>{k}</span><b>{v}</b></div>
          ))}
        </div>
      )}
      <h2>Catalogue & validations</h2>
      <table className="table">
        <thead><tr><th>Titre</th><th>Type</th><th>Créateur</th><th>Statut</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><Link href={`/series/${r.slug}`}>{r.title}</Link><br /><small className="muted">{r.author}</small></td>
              <td>{TYPE_LABEL[r.type]}</td><td>{r.creator ?? '—'}</td><td>{r.publish_status}</td>
              <td className="actions">
                {r.publish_status !== 'published' && <button className="btn btn-gold btn-sm" onClick={() => set(r.id, 'published')}>Publier</button>}
                {r.publish_status === 'published' && <>
                  <button className="btn btn-ghost btn-sm" onClick={() => set(r.id, 'published', true)}>★ À la une</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => set(r.id, 'draft', false)}>Dépublier</button>
                </>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
