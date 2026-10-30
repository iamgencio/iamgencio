/** Creates two funded demo users (Tier 1, phone verified, PIN 1234). Run: npm run seed */
import { pool, tx } from '../src/db';
import { migrate } from '../src/migrate';
import { ensureAdmin } from '../src/services/bootstrap';
import { hashPassword } from '../src/lib/crypto';
import { newReferralCode } from '../src/services/auth';
import { createWallet } from '../src/services/ledger';
import { creditDeposit } from '../src/services/wallets';

async function main() {
  await migrate();
  await ensureAdmin();
  for (const [first, last, email, phone, tag] of [
    ['Ada', 'Obi', 'ada@demo.test', '+2348011111111', 'ada'],
    ['Musa', 'Bello', 'musa@demo.test', '+2348022222222', 'musa'],
  ]) {
    const exists = await pool.query('SELECT 1 FROM users WHERE email=$1', [email]);
    if (exists.rowCount) continue;
    const wallet = await tx(async (c) => {
      const u = (await c.query(
        `INSERT INTO users (email, phone, first_name, last_name, paytag, password_hash, pin_hash, kyc_tier, email_verified_at, phone_verified_at, referral_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,now(),now(),$8) RETURNING id`,
        [email, phone, first, last, tag, await hashPassword('Passw0rd!x'), await hashPassword('1234'), await newReferralCode()])).rows[0];
      return createWallet(c, { userId: u.id, currency: 'NGN' });
    });
    await creditDeposit({ accountNumber: wallet.account_number, amount: 50_000_00, externalReference: `SEED-${tag}`, senderName: 'Seed' });
    console.log(`Created ${email} (password Passw0rd!x, PIN 1234) account ${wallet.account_number}`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
