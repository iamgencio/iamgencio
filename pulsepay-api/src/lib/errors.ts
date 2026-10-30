export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, d?: unknown, code = 'bad_request') => new AppError(400, code, m, d);
export const unauthorized = (m = 'Authentication required', code = 'unauthorized') => new AppError(401, code, m);
export const forbidden = (m = 'Forbidden', code = 'forbidden') => new AppError(403, code, m);
export const notFound = (m = 'Not found', code = 'not_found') => new AppError(404, code, m);
export const conflict = (m: string, code = 'conflict') => new AppError(409, code, m);
export const unprocessable = (m: string, code = 'unprocessable', d?: unknown) => new AppError(422, code, m, d);
export const tooMany = (m: string, code = 'too_many_requests') => new AppError(429, code, m);
