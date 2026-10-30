import { z } from 'zod';
import { routes } from './registry';

const toSchema = (s: any) => {
  const j: any = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });
  delete j.$schema;
  return j;
};

export function buildOpenApi() {
  const paths: Record<string, any> = {};
  for (const r of routes) {
    const p = r.path.replace(/:([A-Za-z_]+)/g, '{$1}');
    const params: any[] = [...(r.path.matchAll(/:([A-Za-z_]+)/g))].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    if (r.query) {
      const js = toSchema(r.query);
      for (const [name, schema] of Object.entries<any>(js.properties ?? {})) {
        params.push({ name, in: 'query', required: (js.required ?? []).includes(name), schema });
      }
    }
    if (r.idempotent) params.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 100 }, description: 'Unique key per logical operation; retries with the same key and body return the original response.' });
    (paths[p] ??= {})[r.method] = {
      tags: r.tags, summary: r.summary, description: r.description,
      ...(r.auth !== 'none' ? { security: [{ bearerAuth: [] }] } : {}),
      parameters: params.length ? params : undefined,
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: toSchema(r.body) } } } } : {}),
      responses: {
        '200': { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } },
        '4XX': { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'PulsePay API', version: '1.0.0',
      description: 'Digital banking API: wallets, transfers, bills, cards, savings, FX, KYC. **All amounts are integers in minor units** (kobo/cents). Responses use `{ success, data, meta? }`; errors use `{ success:false, error:{ code, message, details? } }`.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        Envelope: { type: 'object', properties: { success: { type: 'boolean' }, data: {}, meta: { type: 'object' } } },
        Error: { type: 'object', properties: { success: { type: 'boolean', example: false }, error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } } },
      },
    },
    paths,
  };
}
