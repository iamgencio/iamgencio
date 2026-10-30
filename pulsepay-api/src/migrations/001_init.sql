-- PulsePay core schema. All money is stored as integer minor units (kobo, cents...).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL,
  phone                 text NOT NULL,
  first_name            text NOT NULL,
  last_name             text NOT NULL,
  paytag                text,
  password_hash         text NOT NULL,
  pin_hash              text,
  role                  text NOT NULL DEFAULT 'user' CHECK (role IN ('user','support','admin')),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  kyc_tier              smallint NOT NULL DEFAULT 0 CHECK (kyc_tier BETWEEN 0 AND 3),
  email_verified_at     timestamptz,
  phone_verified_at     timestamptz,
  date_of_birth         date,
  address               jsonb,
  avatar_url            text,
  failed_login_attempts int NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  pin_attempts          int NOT NULL DEFAULT 0,
  pin_locked_until      timestamptz,
  referral_code         text NOT NULL,
  referred_by           uuid REFERENCES users(id),
  notification_prefs    jsonb NOT NULL DEFAULT '{"email":true,"sms":true,"push":true}',
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX users_phone_uq ON users (phone);
CREATE UNIQUE INDEX users_paytag_uq ON users (lower(paytag)) WHERE paytag IS NOT NULL;
CREATE UNIQUE INDEX users_referral_uq ON users (referral_code);

CREATE TABLE otps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  target      text NOT NULL,                -- email or phone the code was sent to
  channel     text NOT NULL CHECK (channel IN ('email','sms')),
  purpose     text NOT NULL,                -- verify_email, verify_phone, reset_password, login_2fa ...
  code_hash   text NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otps_lookup ON otps (target, purpose, created_at DESC);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  device_name  text,
  user_agent   text,
  ip           text,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  replaced_by  uuid,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE kyc_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('bvn','nin','id_document','address_proof','selfie')),
  tier_target   smallint NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}',   -- never contains raw BVN/NIN, only masked + provider result
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reason        text,
  reviewed_by   uuid REFERENCES users(id),
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kyc_user ON kyc_submissions (user_id);
CREATE INDEX kyc_status ON kyc_submissions (status);

-- Wallets: main (one per currency per user), savings pockets, card wallets and system wallets.
CREATE TABLE wallets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES users(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('main','savings','card','system')),
  currency       text NOT NULL,
  name           text NOT NULL DEFAULT 'Main wallet',
  account_number text NOT NULL UNIQUE,
  balance        bigint NOT NULL DEFAULT 0,
  allow_negative boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_non_negative CHECK (allow_negative OR balance >= 0)
);
CREATE UNIQUE INDEX wallets_one_main_per_currency ON wallets (user_id, currency) WHERE kind = 'main';
CREATE INDEX wallets_user ON wallets (user_id);

CREATE TABLE transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference         text NOT NULL UNIQUE,
  external_reference text UNIQUE,            -- provider/webhook reference (dedup)
  type              text NOT NULL,           -- deposit, transfer_internal, transfer_bank, bill, card_fund, card_spend, savings_deposit, savings_withdraw, exchange, interest, reversal, adjustment, payment_request
  category          text NOT NULL DEFAULT 'other',
  status            text NOT NULL DEFAULT 'success' CHECK (status IN ('pending','success','failed','reversed')),
  currency          text NOT NULL,
  amount            bigint NOT NULL CHECK (amount > 0),
  fee               bigint NOT NULL DEFAULT 0 CHECK (fee >= 0),
  narration         text,
  sender_wallet_id  uuid REFERENCES wallets(id),
  receiver_wallet_id uuid REFERENCES wallets(id),
  sender_user_id    uuid REFERENCES users(id),
  receiver_user_id  uuid REFERENCES users(id),
  counterparty      jsonb,                   -- {name, account_number, bank_name, ...}
  meta              jsonb NOT NULL DEFAULT '{}',
  parent_id         uuid REFERENCES transactions(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);
CREATE INDEX tx_sender ON transactions (sender_user_id, created_at DESC);
CREATE INDEX tx_receiver ON transactions (receiver_user_id, created_at DESC);
CREATE INDEX tx_created ON transactions (created_at DESC);
CREATE INDEX tx_type_status ON transactions (type, status);

CREATE TABLE ledger_entries (
  id             bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  wallet_id      uuid NOT NULL REFERENCES wallets(id),
  direction      text NOT NULL CHECK (direction IN ('debit','credit')),
  amount         bigint NOT NULL CHECK (amount > 0),
  currency       text NOT NULL,
  balance_after  bigint NOT NULL,
  label          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_wallet ON ledger_entries (wallet_id, id DESC);
CREATE INDEX ledger_tx ON ledger_entries (transaction_id);

CREATE TABLE idempotency_keys (
  user_id      uuid NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  status_code  int,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE beneficiaries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           text NOT NULL CHECK (type IN ('internal','bank')),
  name           text NOT NULL,
  account_number text NOT NULL,
  bank_code      text,
  bank_name      text,
  is_favorite    boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, account_number, bank_code)
);

CREATE TABLE payment_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payer_id     uuid REFERENCES users(id),         -- null = open payment link
  currency     text NOT NULL,
  amount       bigint NOT NULL CHECK (amount > 0),
  note         text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','declined','cancelled','expired')),
  transaction_id uuid REFERENCES transactions(id),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX preq_requester ON payment_requests (requester_id);
CREATE INDEX preq_payer ON payment_requests (payer_id);

CREATE TABLE bill_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  category       text NOT NULL,
  provider_code  text NOT NULL,
  plan_code      text,
  customer_ref   text NOT NULL,                  -- phone, meter, smartcard...
  customer_name  text,
  amount         bigint NOT NULL,
  token          text,                           -- electricity token etc.
  status         text NOT NULL,
  provider_reference text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bills_user ON bill_payments (user_id, created_at DESC);

CREATE TABLE cards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id     uuid NOT NULL REFERENCES wallets(id),
  label         text NOT NULL,
  brand         text NOT NULL,
  currency      text NOT NULL,
  last4         text NOT NULL,
  pan_enc       text NOT NULL,
  cvv_enc       text NOT NULL,
  exp_month     smallint NOT NULL,
  exp_year      smallint NOT NULL,
  holder_name   text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','terminated')),
  spend_limit   bigint,                          -- per-transaction limit in minor units
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cards_user ON cards (user_id);

CREATE TABLE savings_pockets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id    uuid NOT NULL UNIQUE REFERENCES wallets(id),
  name         text NOT NULL,
  type         text NOT NULL CHECK (type IN ('flexible','locked','target')),
  target_amount bigint,
  locked_until timestamptz,
  interest_rate_bps int NOT NULL DEFAULT 0,       -- annual rate in basis points
  interest_earned bigint NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX savings_user ON savings_pockets (user_id);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notif_user ON notifications (user_id, created_at DESC);

CREATE TABLE support_tickets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject    text NOT NULL,
  category   text NOT NULL DEFAULT 'general',
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','resolved','closed')),
  transaction_id uuid REFERENCES transactions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE support_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id),
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id         bigserial PRIMARY KEY,
  actor_id   uuid,
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  ip         text,
  meta       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_action ON audit_logs (action, created_at DESC);

-- System wallets (negative balances allowed: they mirror the outside world).
INSERT INTO wallets (kind, currency, name, account_number, allow_negative) VALUES
  ('system','NGN','SETTLEMENT_NGN','SYS-SETTLEMENT-NGN', true),
  ('system','NGN','FEES_NGN','SYS-FEES-NGN', true),
  ('system','NGN','BILLS_NGN','SYS-BILLS-NGN', true),
  ('system','NGN','INTEREST_NGN','SYS-INTEREST-NGN', true),
  ('system','NGN','CARDS_NGN','SYS-CARDS-NGN', true),
  ('system','NGN','ADJUSTMENTS_NGN','SYS-ADJUST-NGN', true);
