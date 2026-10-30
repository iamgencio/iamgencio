import { NextFunction, Request, Response, Router } from 'express';
import { ZodError, ZodType } from 'zod';
import { AppError, forbidden, unauthorized } from '../lib/errors';
import { AuthUser, authenticate } from './auth';
import { idempotency } from './idempotency';

export type AuthMode = 'none' | 'user' | 'staff' | 'admin';

export class Result {
  constructor(public data: unknown, public meta?: unknown, public status = 200) {}
}
export const created = (data: unknown) => new Result(data, undefined, 201);
export const paged = (data: unknown, meta: unknown) => new Result(data, meta);

export interface Ctx<B = any, Q = any, P = any> {
  req: Request;
  res: Response;
  body: B;
  query: Q;
  params: P;
  user: AuthUser; // present when auth !== 'none' (use ctx.maybeUser for optional contexts)
}

export interface RouteDef<B = any, Q = any> {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  auth: AuthMode;
  body?: ZodType<B>;
  query?: ZodType<Q>;
  idempotent?: boolean; // requires Idempotency-Key header
  handler: (ctx: Ctx<B, Q>) => Promise<unknown> | unknown;
}

export const routes: RouteDef[] = [];
export function route<B = any, Q = any>(def: RouteDef<B, Q>) {
  routes.push(def as RouteDef);
}

function parse<T>(schema: ZodType<T> | undefined, value: unknown): T {
  if (!schema) return value as T;
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw validationError(r.error);
  return r.data;
}

export function validationError(e: ZodError) {
  return new AppError(
    422,
    'validation_error',
    'Request validation failed',
    e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}

export function mountRoutes(router: Router) {
  for (const def of routes) {
    const chain: any[] = [];
    if (def.auth !== 'none') {
      chain.push(wrap(async (req, _res, next) => {
        (req as any).user = await authenticate(req);
        next();
      }));
      if (def.auth === 'admin') chain.push(roleGuard(['admin']));
      if (def.auth === 'staff') chain.push(roleGuard(['admin', 'support']));
      if (def.idempotent) chain.push(wrap(idempotency));
    }
    chain.push(wrap(async (req, res) => {
      const out = await def.handler({
        req,
        res,
        body: parse(def.body, req.body),
        query: parse(def.query, req.query),
        params: req.params,
        user: (req as any).user,
      });
      if (res.headersSent) return;
      const r = out instanceof Result ? out : new Result(out);
      res.status(r.status).json({ success: true, data: r.data ?? null, ...(r.meta ? { meta: r.meta } : {}) });
    }));
    router[def.method](def.path, ...chain);
  }
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
export const wrap = (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res, next).catch(next);
};

const roleGuard = (roles: string[]) => (req: Request, _res: Response, next: NextFunction) => {
  const u = (req as any).user as AuthUser | undefined;
  if (!u) return next(unauthorized());
  if (!roles.includes(u.role)) return next(forbidden('Insufficient permissions'));
  next();
};
