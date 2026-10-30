/**
 * Adapters for third-party rails (bank switch, bill aggregator, KYC, SMS/email).
 * The implementations below are deterministic sandbox mocks so the API runs end to end without credentials.
 * Swap each function body for a real provider (NIBSS/Paystack/Flutterwave, VTpass/Baxi, Smile ID/Dojah, Termii/Twilio...).
 */
import { config } from '../config';
import { logger } from '../logger';
import { randomDigits } from '../lib/crypto';

export const BANKS = [
  { code: '044', name: 'Access Bank' }, { code: '023', name: 'Citibank Nigeria' }, { code: '050', name: 'Ecobank Nigeria' },
  { code: '070', name: 'Fidelity Bank' }, { code: '011', name: 'First Bank of Nigeria' }, { code: '214', name: 'First City Monument Bank' },
  { code: '058', name: 'Guaranty Trust Bank' }, { code: '030', name: 'Heritage Bank' }, { code: '301', name: 'Jaiz Bank' },
  { code: '082', name: 'Keystone Bank' }, { code: '50211', name: 'Kuda Microfinance Bank' }, { code: '999992', name: 'OPay' },
  { code: '999991', name: 'PalmPay' }, { code: '076', name: 'Polaris Bank' }, { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '068', name: 'Standard Chartered Bank' }, { code: '232', name: 'Sterling Bank' }, { code: '032', name: 'Union Bank of Nigeria' },
  { code: '033', name: 'United Bank for Africa' }, { code: '215', name: 'Unity Bank' }, { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
];

const SANDBOX_NAMES = ['ADE OLUWASEUN', 'CHIOMA OKAFOR', 'IBRAHIM MUSA', 'FATIMA BELLO', 'EMEKA NWOSU', 'TUNDE BAKARE', 'AMINA YUSUF'];

export async function resolveBankAccount(bankCode: string, accountNumber: string): Promise<{ account_name: string; account_number: string; bank_code: string; bank_name: string } | null> {
  const bank = BANKS.find((b) => b.code === bankCode);
  if (!bank || !/^\d{10}$/.test(accountNumber)) return null;
  if (accountNumber.startsWith('00')) return null; // sandbox: unknown account
  const name = SANDBOX_NAMES[Number(accountNumber.slice(-2)) % SANDBOX_NAMES.length];
  return { account_name: name, account_number: accountNumber, bank_code: bank.code, bank_name: bank.name };
}

export interface ProviderResult { status: 'success' | 'failed' | 'pending'; reference: string; message?: string; token?: string }

export async function sendBankTransfer(p: { bankCode: string; accountNumber: string; amount: number; reference: string }): Promise<ProviderResult> {
  // sandbox convention: account numbers ending in 0000 fail, ending in 9999 stay pending
  if (p.accountNumber.endsWith('0000')) return { status: 'failed', reference: 'NIP' + randomDigits(12), message: 'Beneficiary bank rejected the transfer' };
  if (p.accountNumber.endsWith('9999')) return { status: 'pending', reference: 'NIP' + randomDigits(12) };
  return { status: 'success', reference: 'NIP' + randomDigits(12) };
}

// ---- Bills ----
export interface BillPlan { code: string; name: string; amount: number }
export interface BillProvider { code: string; name: string; category: string; fixedAmount: boolean; plans?: BillPlan[]; validate?: boolean }

const dataPlans = (prefix: string): BillPlan[] => [
  { code: `${prefix}-DATA-1GB-1D`, name: '1GB - 1 day', amount: 30_000 },
  { code: `${prefix}-DATA-2GB-7D`, name: '2GB - 7 days', amount: 50_000 },
  { code: `${prefix}-DATA-6GB-30D`, name: '6GB - 30 days', amount: 150_000 },
  { code: `${prefix}-DATA-15GB-30D`, name: '15GB - 30 days', amount: 300_000 },
];

export const BILL_PROVIDERS: BillProvider[] = [
  ...['MTN', 'AIRTEL', 'GLO', '9MOBILE'].map((n) => ({ code: `${n}-AIRTIME`, name: `${n} Airtime`, category: 'airtime', fixedAmount: false })),
  ...['MTN', 'AIRTEL', 'GLO', '9MOBILE'].map((n) => ({ code: `${n}-DATA`, name: `${n} Data`, category: 'data', fixedAmount: true, plans: dataPlans(n) })),
  ...['IKEDC', 'EKEDC', 'AEDC', 'PHED', 'KEDCO'].flatMap((n) => [
    { code: `${n}-PREPAID`, name: `${n} Prepaid`, category: 'electricity', fixedAmount: false, validate: true },
    { code: `${n}-POSTPAID`, name: `${n} Postpaid`, category: 'electricity', fixedAmount: false, validate: true },
  ]),
  { code: 'DSTV', name: 'DStv', category: 'tv', fixedAmount: true, validate: true, plans: [
    { code: 'DSTV-PADI', name: 'DStv Padi', amount: 250_000 }, { code: 'DSTV-YANGA', name: 'DStv Yanga', amount: 350_000 },
    { code: 'DSTV-COMPACT', name: 'DStv Compact', amount: 1_250_000 }, { code: 'DSTV-PREMIUM', name: 'DStv Premium', amount: 2_950_000 } ] },
  { code: 'GOTV', name: 'GOtv', category: 'tv', fixedAmount: true, validate: true, plans: [
    { code: 'GOTV-SMALLIE', name: 'GOtv Smallie', amount: 130_000 }, { code: 'GOTV-JOLLI', name: 'GOtv Jolli', amount: 395_000 },
    { code: 'GOTV-MAX', name: 'GOtv Max', amount: 850_000 } ] },
  { code: 'STARTIMES', name: 'StarTimes', category: 'tv', fixedAmount: true, validate: true, plans: [
    { code: 'ST-BASIC', name: 'Basic', amount: 130_000 }, { code: 'ST-SMART', name: 'Smart', amount: 230_000 } ] },
  { code: 'SPECTRANET', name: 'Spectranet', category: 'internet', fixedAmount: true, validate: true, plans: [
    { code: 'SPEC-10GB', name: '10GB', amount: 500_000 }, { code: 'SPEC-50GB', name: '50GB', amount: 1_500_000 } ] },
  { code: 'SMILE', name: 'Smile', category: 'internet', fixedAmount: true, validate: true, plans: [
    { code: 'SMILE-5GB', name: '5GB', amount: 300_000 }, { code: 'SMILE-20GB', name: '20GB', amount: 900_000 } ] },
];
export const BILL_CATEGORIES = ['airtime', 'data', 'electricity', 'tv', 'internet'];

export async function validateCustomer(provider: BillProvider, customerRef: string): Promise<{ customer_name: string; address?: string } | null> {
  if (!/^\d{6,13}$/.test(customerRef)) return null;
  if (customerRef.startsWith('00')) return null;
  const name = SANDBOX_NAMES[Number(customerRef.slice(-2)) % SANDBOX_NAMES.length];
  return { customer_name: name, ...(provider.category === 'electricity' ? { address: '12 Sandbox Avenue, Lagos' } : {}) };
}

export async function payBill(provider: BillProvider, customerRef: string, amount: number): Promise<ProviderResult> {
  if (customerRef.endsWith('0000')) return { status: 'failed', reference: 'BP' + randomDigits(10), message: 'Biller unavailable' };
  const token = provider.category === 'electricity' && provider.code.endsWith('PREPAID')
    ? randomDigits(20).replace(/(\d{4})(?=\d)/g, '$1-') : undefined;
  return { status: 'success', reference: 'BP' + randomDigits(10), token };
}

// ---- KYC ----
export async function verifyBvn(bvn: string, firstName: string, lastName: string): Promise<{ verified: boolean; reason?: string }> {
  if (!/^\d{11}$/.test(bvn)) return { verified: false, reason: 'BVN must be 11 digits' };
  if (bvn.startsWith('0')) return { verified: false, reason: 'BVN not found' };
  return { verified: true };
}
export async function verifyNin(nin: string): Promise<{ verified: boolean; reason?: string }> {
  if (!/^\d{11}$/.test(nin)) return { verified: false, reason: 'NIN must be 11 digits' };
  if (nin.startsWith('0')) return { verified: false, reason: 'NIN not found' };
  return { verified: true };
}

// ---- Messaging ----
export async function sendSms(to: string, text: string) { logger.info({ channel: 'sms', to, text }, 'sms (sandbox)'); }
export async function sendEmail(to: string, subject: string, text: string) { logger.info({ channel: 'email', to, subject, text }, 'email (sandbox)'); }

export const isLive = () => config.isProd;
