'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fcfa, type Plan } from '@/lib/api';
import { useAuth } from '@/lib/auth';

type Plans = { plans: Plan[]; networks: Record<string, string>; mode: string };

export default function Premium() {
  const { user, ready, refresh } = useAuth();
  const [d, setD] = useState<Plans | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [network, setNetwork] = useState('mtn');
  const [phone, setPhone] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'pending' | 'success' | 'failed'>('idle');
  const [err, setErr] = useState('');

  useEffect(() => { api<Plans>('/plans').then(setD).catch(() => setErr('Formules indisponibles')); }, []);

  const poll = async (ref: string, tries = 0): Promise<void> => {
    const r = await api<{ status: 'pending' | 'success' | 'failed' }>(`/payments/${ref}`);
    if (r.status === 'success') { setState('success'); await refresh(); return; }
    if (r.status === 'failed') { setState('failed'); return; }
    if (tries > 40) { setState('failed'); setErr("Le paiement n'a pas été confirmé à temps. Si vous avez été débité, il sera pris en compte automatiquement."); return; }
    setTimeout(() => poll(ref, tries + 1).catch(() => {}), 3000);
  };

  const pay = async () => {
    if (!plan) return;
    setErr(''); setState('busy');
    try {
      const r = await api<{ reference: string; status: string }>('/payments/checkout', { method: 'POST', body: { plan_id: plan.id, network, phone } });
      if (r.status === 'success') { setState('success'); await refresh(); } else { setState('pending'); poll(r.reference); }
    } catch (e) { setErr((e as Error).message); setState('idle'); }
  };

  if (state === 'success') return (
    <div className="empty"><h1>★ Bienvenue chez Nyota Premium</h1><p>Tous les chapitres sont maintenant débloqués.</p><Link href="/browse" className="btn btn-gold">Lire maintenant</Link></div>
  );

  return (
    <div className="page">
      <h1>Nyota Premium</h1>
      <p className="muted">Débloquez tous les chapitres, sans publicité, et soutenez directement les auteurs. Paiement par Mobile Money via FeexPay.</p>
      {d?.mode === 'mock' && <p className="notice">Mode test : le paiement est simulé, aucun débit réel.</p>}
      <div className="plans">
        {d?.plans.map((p) => (
          <button key={p.id} className={`plan ${plan?.id === p.id ? 'on' : ''}`} onClick={() => setPlan(p)}>
            <b>{p.name}</b><span className="price">{fcfa(p.price_xof)}</span>
            <small>{p.duration_days} jours</small>
            <ul>{p.perks.map((x) => <li key={x}>✓ {x}</li>)}</ul>
          </button>
        ))}
      </div>
      {plan && (ready && !user ? (
        <div className="empty">Connectez-vous pour continuer. <Link href="/login?next=/premium" className="btn btn-gold">Connexion</Link></div>
      ) : (
        <div className="checkout">
          <h2>Payer {fcfa(plan.price_xof)}</h2>
          <div className="chips">{d && Object.entries(d.networks).map(([k, v]) => <button key={k} className={`chip ${network === k ? 'on' : ''}`} onClick={() => setNetwork(k)}>{v}</button>)}</div>
          <label>Numéro Mobile Money<input inputMode="tel" placeholder="Ex. 97 00 00 00" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          {err && <p className="error" role="alert">{err}</p>}
          {state === 'pending' && <p className="notice">Confirmez le paiement sur votre téléphone (code USSD)… en attente.</p>}
          {state === 'failed' && <p className="error">Paiement échoué ou annulé. Vous pouvez réessayer.</p>}
          <button className="btn btn-gold" disabled={state === 'busy' || state === 'pending' || phone.replace(/\D/g, '').length < 8} onClick={pay}>
            {state === 'busy' ? 'Envoi…' : state === 'pending' ? 'En attente…' : 'Payer maintenant'}
          </button>
        </div>
      ))}
    </div>
  );
}
