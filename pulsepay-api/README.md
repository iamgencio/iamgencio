# PulsePay API

Backend for a PalmPay / Revolut-style digital banking **web platform**: wallets, transfers, bills, virtual cards, savings, FX, KYC, admin back-office.
Node 22 · TypeScript · Express · PostgreSQL · Zod. **109 endpoints**, interactive docs at `/docs` (OpenAPI at `/api/v1/openapi.json`).

## Quick start

```bash
cp .env.example .env          # quote values containing '#'
npm install
npm run migrate               # creates the schema
npm run seed                  # optional: admin + 2 funded demo users (PIN 1234, password Passw0rd!x)
npm run dev                   # http://localhost:4000  ·  docs: http://localhost:4000/docs
npm test                      # integration tests against a real PostgreSQL (TEST_DATABASE_URL)
```

Admin is created on boot from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
Tests drop and recreate the `public` schema of the database in `TEST_DATABASE_URL`
(default `postgres://pulse:pulse@localhost:5432/pulsepay_test`) — never point it at real data.

## Conventions

* Base path `/api/v1`. Success: `{ success: true, data, meta? }`. Error: `{ success: false, error: { code, message, details? } }`.
* **Money = integers in minor units** (kobo/cents). Never floats.
* Auth: `Authorization: Bearer <access_token>` (15 min). Refresh tokens rotate; replaying an old one revokes every session.
* **Money-moving POSTs require an `Idempotency-Key` header**; retries return the original response (`Idempotent-Replay: true`).
* Every money-out action also needs the user's 4-digit **transaction PIN** in the body (3 wrong tries → 30 min lock) and a verified phone.
* In non-production, OTP codes are returned as `dev_otp` / `dev_otps` so a front end can be built without SMS/email.

## Modules

| Area | Highlights |
|---|---|
| Auth | register, login, refresh rotation + reuse detection, logout/all, sessions & devices, email/phone OTP, forgot/reset/change password, transaction PIN (set/change/reset), lockouts |
| Users / KYC | profile, PayTag, user lookup, referral code, limits & usage, close account. **Tiers 0-3**: BVN/NIN (instant) → ID + selfie (manual) → proof of address (manual) with per-tier single/daily/balance caps |
| Wallets | multi-currency (NGN, USD, GBP, EUR, GHS, KES), virtual account number per wallet, statements (JSON/CSV) with running balance, net-worth summary |
| Transfers | free instant P2P by account number / PayTag / phone; NGN bank transfers with fee schedule, name enquiry, auto-refund on failure, pending → webhook settlement; beneficiaries |
| Requests | request money from a user or via a shareable code; pay / decline / cancel |
| Bills | airtime, data, electricity (token), TV, internet; customer validation; refund on biller failure |
| Cards | virtual cards (Mastercard NGN / Visa USD), fund/withdraw, freeze, limits, PIN-gated reveal (PAN/CVV AES-256-GCM at rest), issuer webhook |
| Savings | flexible / locked / target pockets, daily interest accrual job |
| Exchange | quote + convert between your currency wallets (spread, FX system wallets) |
| Transactions | filters, search, receipts, spending insights by category, report-a-problem → ticket |
| Notifications / Support | in-app notifications, preferences, tickets with messages |
| Admin | KPIs, ledger integrity check, user search / suspend / tier / roles, KYC review queue, transaction search & reversal, wallet freeze & manual adjustment, audit log, support queue, interest job |
| Webhooks | `POST /webhooks/psp` (HMAC-SHA256 `x-signature`): `deposit.success`, `transfer.success|failed`, `card.charge` — idempotent |

## Money safety design

* **Double-entry ledger**: every movement posts balanced debit/credit legs (per currency) in one DB transaction; wallets locked in id order; `CHECK (balance >= 0)` for customer wallets. System wallets (settlement, fees, bills, FX, interest, cards, adjustments) mirror the outside world and may go negative.
* `GET /admin/ledger/integrity` verifies every wallet balance equals the sum of its entries and that each currency nets to zero.
* Two-phase external calls (bank rail, billers): funds are reserved as `pending`, the provider is called **outside** the DB transaction, then the result finalizes or reverses. Timeouts never auto-refund; the webhook/reconciliation decides.
* Per-user advisory locks serialize limit checks; open payment links are claimed atomically.

## Sandbox providers → going live

`src/services/providers.ts` holds deterministic mocks for the bank rail, name enquiry, billers, BVN/NIN verification and SMS/email. Replace each function with a real provider (e.g. Paystack/Flutterwave/NIBSS, VTpass/Baxi, Smile ID/Dojah, Termii/Twilio, a card issuer such as Sudo/Bridgecard). Sandbox rules: bank account `…0000` fails, `…9999` stays pending; unknown accounts start with `00`; bill refs ending `0000` fail.

## Before production

Set strong `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, `WEBHOOK_SECRET` (the app refuses to start with defaults), run behind HTTPS, add a scheduler for `POST /admin/jobs/accrue-interest`, a reconciliation job for `pending` transactions, real SMS/email, KMS for the data key, and a compliance review (CBN licensing, NDPR, AML screening/transaction monitoring) — not included here.
