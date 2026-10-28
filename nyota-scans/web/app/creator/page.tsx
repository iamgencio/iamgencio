'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, TYPE_LABEL, type Genre, type SeriesType } from '@/lib/api';
import { useAuth } from '@/lib/auth';

type Mine = { id: number; slug: string; title: string; type: SeriesType; publish_status: 'draft' | 'pending' | 'published'; views: number; chapter_count: number };
const STATUS = { draft: 'Brouillon', pending: 'En validation', published: 'Publié' };

export default function Creator() {
  const { user, ready } = useAuth();
  const [items, setItems] = useState<Mine[]>([]);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api<{ items: Mine[] }>('/creator/series').then((r) => setItems(r.items)).catch(() => {}), []);
  useEffect(() => { if (user && user.role !== 'reader') { load(); api<{ genres: Genre[] }>('/genres').then((r) => setGenres(r.genres)); } }, [user, load]);

  if (!ready) return <div className="empty">Chargement…</div>;
  if (!user || user.role === 'reader') return <div className="empty">Espace réservé aux créateurs. <Link className="btn btn-gold" href="/register?role=creator">Devenir créateur</Link></div>;

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const form = e.currentTarget;
    try {
      const r = await api<{ id: number }>('/creator/series', { method: 'POST', body: {
        title: fd.get('title'), synopsis: fd.get('synopsis'), type: fd.get('type'), country: fd.get('country') || null, genres: fd.getAll('genres'),
      } });
      const cover = fd.get('cover') as File;
      if (cover && cover.size) { const f = new FormData(); f.set('cover', cover); await api(`/creator/series/${r.id}/cover`, { method: 'POST', form: f }); }
      form.reset(); setMsg('Série créée en brouillon. Ajoutez vos chapitres, puis soumettez-la.'); load();
    } catch (e) { setMsg((e as Error).message); }
  };

  const addChapter = async (id: number, e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    if (!fd.get('is_premium')) fd.delete('is_premium');
    try { await api(`/creator/series/${id}/chapters`, { method: 'POST', form: fd }); form.reset(); setMsg('Chapitre ajouté.'); load(); }
    catch (e) { setMsg((e as Error).message); }
  };

  const submit = async (id: number) => {
    try { await api(`/creator/series/${id}/submit`, { method: 'POST' }); setMsg("Soumise à l'équipe Starlight pour validation."); load(); } catch (e) { setMsg((e as Error).message); }
  };

  return (
    <div className="page">
      <h1>Espace créateur</h1>
      {msg && <p className="notice" role="status">{msg}</p>}
      <div className="two">
        <form className="panel" onSubmit={create}>
          <h2>Nouvelle série</h2>
          <label>Titre<input name="title" required /></label>
          <label>Synopsis<textarea name="synopsis" required rows={4} /></label>
          <label>Type<select name="type" defaultValue="bd_africaine">{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Pays<input name="country" /></label>
          <fieldset><legend>Genres</legend><div className="chips">{genres.map((g) => <label key={g.slug} className="chip"><input type="checkbox" name="genres" value={g.slug} /> {g.name}</label>)}</div></fieldset>
          <label>Couverture (JPG/PNG/WebP, 8 Mo max)<input name="cover" type="file" accept="image/jpeg,image/png,image/webp" /></label>
          <button className="btn btn-gold">Créer la série</button>
        </form>
        <div>
          <h2>Mes séries</h2>
          {items.length === 0 && <p className="muted">Aucune série pour l&apos;instant.</p>}
          {items.map((s) => (
            <div className="panel" key={s.id}>
              <div className="between"><b>{s.title}</b><span className="pill">{STATUS[s.publish_status]}</span></div>
              <p className="muted">{TYPE_LABEL[s.type]} · {s.chapter_count} chapitre(s) · {s.views} lectures</p>
              <form onSubmit={(e) => addChapter(s.id, e)} className="inline">
                <input name="number" type="number" step="0.5" min="0" placeholder="N°" required style={{ width: 70 }} />
                <input name="title" placeholder="Titre (optionnel)" />
                <label className="chip"><input type="checkbox" name="is_premium" value="1" /> Premium</label>
                <input name="pages[]" type="file" multiple required accept="image/jpeg,image/png,image/webp" />
                <button className="btn btn-ghost btn-sm">Ajouter le chapitre</button>
              </form>
              {s.publish_status === 'draft' && s.chapter_count > 0 && <button className="btn btn-gold btn-sm" onClick={() => submit(s.id)}>Soumettre pour publication</button>}
              {s.publish_status === 'published' && <Link href={`/series/${s.slug}`} className="link">Voir la page publique</Link>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
