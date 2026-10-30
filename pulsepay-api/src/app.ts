import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { config } from './config';
import { logger } from './logger';
import { AppError } from './lib/errors';
import { mountRoutes } from './http/registry';

import './routes/system';
import './routes/auth';
import './routes/users';
import './routes/kyc';
import './routes/wallets';
import './routes/transfers';
import './routes/transactions';
import './routes/bills';
import './routes/cards';
import './routes/savings';
import './routes/notifications';
import './routes/support';
import './routes/webhooks';
import './routes/admin';

const DOCS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>PulsePay API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head><body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:'/api/v1/openapi.json',dom_id:'#ui',persistAuthorization:true})</script></body></html>`;

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const id = req.header('x-request-id') ?? randomUUID();
    (req as any).id = id;
    res.setHeader('x-request-id', id);
    next();
  });
  app.get('/docs', (_req, res) => res.type('html').send(DOCS_HTML)); // before helmet: Swagger UI loads assets from a CDN
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, credentials: true, exposedHeaders: ['x-request-id', 'Idempotent-Replay'] }));
  app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));

  if (!config.isTest) {
    app.use(rateLimit({ windowMs: 60_000, limit: config.rateLimitPerMin, standardHeaders: true, legacyHeaders: false,
      handler: (_req, res) => res.status(429).json({ success: false, error: { code: 'rate_limited', message: 'Too many requests' } }) }));
    const strict = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
      handler: (_req, res) => res.status(429).json({ success: false, error: { code: 'rate_limited', message: 'Too many attempts, slow down' } }) });
    app.use(['/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/forgot-password', '/api/v1/auth/reset-password', '/api/v1/auth/otp'], strict);
  }

  const router = express.Router();
  mountRoutes(router);
  app.use('/api/v1', router);

  app.use((_req, res) => res.status(404).json({ success: false, error: { code: 'route_not_found', message: 'Route not found' } }));

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: { code: 'invalid_json', message: 'Malformed JSON body' } });
    if (err?.type === 'entity.too.large') return res.status(413).json({ success: false, error: { code: 'payload_too_large', message: 'Body too large' } });
    if (err?.code === '23505') return res.status(409).json({ success: false, error: { code: 'duplicate', message: 'Resource already exists' } });
    if (err?.code === '22P02') return res.status(400).json({ success: false, error: { code: 'bad_request', message: 'Malformed identifier' } });
    logger.error({ err, requestId: (req as any).id, path: req.path }, 'unhandled error');
    res.status(500).json({ success: false, error: { code: 'internal_error', message: 'Something went wrong', request_id: (req as any).id } });
  });
  return app;
}
