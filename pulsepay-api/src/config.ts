import 'dotenv/config';
import { z } from 'zod';

const env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(4000),
    DATABASE_URL: z.string().default('postgres://pulse:pulse@localhost:5432/pulsepay'),
    JWT_SECRET: z.string().min(16).default('dev-only-jwt-secret-change-me-please'),
    DATA_ENCRYPTION_KEY: z.string().min(16).default('dev-only-data-key-change-me-please'),
    WEBHOOK_SECRET: z.string().min(8).default('dev-webhook-secret'),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    EXPOSE_DEV_OTP: z.string().default('true'),
    ADMIN_EMAIL: z.string().default('admin@pulsepay.test'),
    ADMIN_PASSWORD: z.string().default('Admin#12345'),
    RATE_LIMIT_PER_MIN: z.coerce.number().default(300),
    LOG_LEVEL: z.string().default('info'),
  })
  .parse(process.env);

const isProd = env.NODE_ENV === 'production';
if (isProd && /dev|change-me/.test(env.JWT_SECRET + env.DATA_ENCRYPTION_KEY + env.WEBHOOK_SECRET)) {
  throw new Error('Refusing to start in production with default/dev secrets');
}

export const config = {
  env: env.NODE_ENV,
  isProd,
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  jwtSecret: env.JWT_SECRET,
  dataKey: env.DATA_ENCRYPTION_KEY,
  webhookSecret: env.WEBHOOK_SECRET,
  corsOrigins: env.CORS_ORIGINS.split(',').map((s) => s.trim()),
  exposeDevOtp: !isProd && env.EXPOSE_DEV_OTP === 'true',
  adminEmail: env.ADMIN_EMAIL,
  adminPassword: env.ADMIN_PASSWORD,
  rateLimitPerMin: env.RATE_LIMIT_PER_MIN,
  logLevel: env.LOG_LEVEL,

  accessTtlSec: 15 * 60,
  refreshTtlSec: 30 * 24 * 3600,
  otpTtlSec: 10 * 60,
  otpMaxAttempts: 5,
  maxLoginAttempts: 5,
  loginLockMin: 15,
  maxPinAttempts: 3,
  pinLockMin: 30,

  baseCurrency: 'NGN',
  currencies: ['NGN', 'USD', 'GBP', 'EUR', 'GHS', 'KES'] as const,
  // Static demo FX rates: units of NGN for 1 unit of currency (mid-market). Replace with a live provider.
  fxRatesToNgn: { NGN: 1, USD: 1500, GBP: 1900, EUR: 1620, GHS: 100, KES: 11.6 } as Record<string, number>,
  fxSpreadBps: 100, // 1% spread kept by the platform

  // KYC tiers. All amounts are in NGN minor units (kobo). Other currencies are converted to NGN for checks.
  tiers: {
    0: { name: 'Tier 0', single: 2_000_000, daily: 5_000_000, maxBalance: 10_000_000 },
    1: { name: 'Tier 1', single: 10_000_000, daily: 30_000_000, maxBalance: 30_000_000 },
    2: { name: 'Tier 2', single: 100_000_000, daily: 500_000_000, maxBalance: 500_000_000 },
    3: { name: 'Tier 3', single: 500_000_000, daily: 2_000_000_000, maxBalance: Number.MAX_SAFE_INTEGER },
  } as Record<number, { name: string; single: number; daily: number; maxBalance: number }>,

  // Interbank transfer fee schedule (NGN kobo).
  bankTransferFees: [
    { upTo: 500_000, fee: 1_000 },
    { upTo: 5_000_000, fee: 2_500 },
    { upTo: Number.MAX_SAFE_INTEGER, fee: 5_000 },
  ],
  savingsRatesBps: { flexible: 800, locked: 1500, target: 1000 } as Record<string, number>,
  cardCreationFee: { NGN: 100_000, USD: 200 } as Record<string, number>,
  paymentRequestTtlDays: 14,
};
