import { z } from 'zod';

export const normalizePhone = (raw: string): string => {
  const s = raw.replace(/[\s\-()]/g, '');
  if (/^0\d{10}$/.test(s)) return '+234' + s.slice(1);
  if (/^234\d{10}$/.test(s)) return '+' + s;
  return s;
};

export const phoneSchema = z.string().transform(normalizePhone).refine((v) => /^\+\d{8,15}$/.test(v), 'Invalid phone number');
export const passwordSchema = z
  .string()
  .min(8)
  .max(72)
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), 'Password needs upper, lower case letters and a digit');
export const pinSchema = z.string().regex(/^\d{4}$/, 'PIN must be 4 digits');
export const amountSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe('Amount in minor units (e.g. kobo)');
export const currencySchema = z.enum(['NGN', 'USD', 'GBP', 'EUR', 'GHS', 'KES']);
export const uuid = z.uuid();

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof pageQuery>;
export const offset = (p: PageQuery) => (p.page - 1) * p.limit;
export const pageMeta = (p: PageQuery, total: number) => ({ page: p.page, limit: p.limit, total, pages: Math.ceil(total / p.limit) });

export const newReference = (prefix = 'TXN') =>
  `${prefix}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

export const maskName = (name: string) => name.split(' ').map((p) => p[0]?.toUpperCase() + p.slice(1).toLowerCase()).join(' ');
