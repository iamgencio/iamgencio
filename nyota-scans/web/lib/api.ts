export type Genre = { slug: string; name: string };
export type SeriesCard = {
  id: number; slug: string; title: string; author: string; type: SeriesType; country: string | null;
  cover_url: string | null; accent: string; status: string; views: number; chapter_count: number; genres: Genre[];
};
export type SeriesType = 'manga' | 'manhwa' | 'bd_africaine' | 'comic';
export type ChapterRow = { id: number; number: string; title: string | null; is_premium: number; published_at: string };
export type SeriesDetail = SeriesCard & {
  synopsis: string; language: string; chapters: ChapterRow[]; is_favorite: boolean;
  last_read: { chapter_id: number; page: number } | null;
};
export type Chapter = {
  id: number; number: string; title: string | null; series_id: number; series_slug: string; series_title: string; accent: string;
  locked: boolean; total_pages: number; pages: { position: number; image_url: string }[]; prev_id: number | null; next_id: number | null;
};
export type User = { id: number; name: string; email: string; role: 'reader' | 'creator' | 'admin'; premium: boolean; premium_until?: string | null };
export type Plan = { id: number; code: string; name: string; price_xof: number; duration_days: number; perks: string[] };

export const TYPE_LABEL: Record<SeriesType, string> = {
  manga: 'Manga', manhwa: 'Manhwa', bd_africaine: 'BD africaine', comic: 'Comic',
};

const PUBLIC = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
const base = () => (typeof window === 'undefined' ? process.env.API_URL || PUBLIC : PUBLIC);

export const TOKEN_KEY = 'nyota_token';
export const getToken = () => (typeof window === 'undefined' ? null : window.localStorage.getItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; form?: FormData; token?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = opts.token ?? getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const res = await fetch(base() + path, { method: opts.method || 'GET', headers, body, cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'Une erreur est survenue');
  return data as T;
}

export const fcfa = (n: number) => new Intl.NumberFormat('fr-FR').format(n) + ' FCFA';
export const compact = (n: number) => new Intl.NumberFormat('fr-FR', { notation: 'compact' }).format(n);
