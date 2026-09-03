// Builds the App Store / Play review account, from the outside, through the public API.
//
// Why a separate company: Apple will not review an app it cannot sign into, and PorchPay
// has no self-service sign-up. A reviewer needs a real login. Giving them one inside SAA
// would put a stranger's session next to real buyers' balances and default notices. This
// signs up its own company instead, so the reviewer sees a complete, working product and
// none of your records — the isolation sweep confirmed that wall holds on all 209 routes.
//
// It touches nothing that already exists. It only creates.
//
//   node seed-demo.js --url https://porchpay-production.up.railway.app
//
// Add --dry to print the plan without creating anything.

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const BASE = (arg('url', 'http://localhost:3000')).replace(/\/$/, '');
const DRY = args.includes('--dry');

// Passwords come from the environment first (DEMO-ACCOUNT.bat puts them there, so they
// never appear on a command line or in a console history), then from a flag, and only
// then from a generated one printed once. Nothing is written to this file, so it stays
// safe to commit.
const pw = (n) => require('crypto').randomBytes(n).toString('base64url').replace(/[-_]/g, '').slice(0, n) + 'aA1!';
const ADMIN_PW = process.env.PORCHPAY_ADMIN_PW || arg('admin-pw', pw(12));
const BUYER_PW = process.env.PORCHPAY_BUYER_PW || arg('buyer-pw', pw(12));
const CHOSE_OWN = !!(process.env.PORCHPAY_ADMIN_PW || args.includes('--admin-pw'));
// Only needed when the server has signups closed, which it should have.
const SIGNUP_TOKEN = process.env.PORCHPAY_SIGNUP_TOKEN || arg('token', '');

const COMPANY = 'Porch Pay Demo Servicing';
const ADMIN_EMAIL = arg('admin-email', 'demo-admin@porchpay.app');
const BUYER_EMAIL = arg('buyer-email', 'appreview@porchpay.app');
const BUYER_NAME = 'Alex Rivera';
// A deliberately fictional street number on a real Flint street, so nothing in the
// screenshots points at a person's actual house.
const ADDRESS = { address: '8800 Crestwood Ln', city: 'Flint', state: 'MI', zip: '48507' };

// A loan far enough along to look like a working account: 20 years at 9.5%, seven years
// of on-time payments behind it. On a 30-year term the progress bar barely moves in the
// first decade, which is exactly why the current Home screenshot reads as 0% paid.
const TERM_MONTHS = 240;
const RATE_BPS = 950;
const PRINCIPAL = 7_800_000;      // $78,000 financed
const SALE_PRICE = 8_700_000;     // $87,000 with $9,000 down
const DOWN = 900_000;
const ESCROW = 24_500;            // taxes + insurance, monthly
const MONTHS_PAID = 84;           // seven years

let cookie = '';
async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...opts,
  });
  const setC = res.headers.get('set-cookie');
  if (setC) cookie = setC.split(';')[0];
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}
const iso = (d) => d.toISOString().slice(0, 10);
const monthsAgo = (n) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); d.setUTCDate(1); return d; };

// A one-page PDF with real text on it, built by hand — no library, and small enough to
// post as base64. Empty document folders are the reason the Documents screenshot is
// unusable today.
function pdf(title, lines) {
  const esc = (s) => String(s).replace(/([()\\])/g, '\\$1');
  let text = `BT /F1 20 Tf 62 742 Td (${esc(title)}) Tj ET\n`;
  lines.forEach((l, i) => { text += `BT /F1 11 Tf 62 ${706 - i * 20} Td (${esc(l)}) Tj ET\n`; });
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n', offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
       + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
       + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1').toString('base64');
}

(async () => {
  console.log(`\nPorch Pay — App Store review account\ntarget: ${BASE}\n`);
  if (DRY) {
    console.log(`would create company "${COMPANY}"`);
    console.log(`  owner  ${ADMIN_EMAIL}`);
    console.log(`  buyer  ${BUYER_EMAIL}  (${BUYER_NAME}, ${ADDRESS.address})`);
    console.log(`  loan   $${(PRINCIPAL / 100).toLocaleString()} at 9.5% over ${TERM_MONTHS} months, ${MONTHS_PAID} payments made`);
    console.log(`  plus 4 documents, a message thread, and no past-due balance`);
    return;
  }

  // A password weak enough to guess is worse here than anywhere else: this account
  // lives on the production server beside real buyers' ledgers, and its credentials get
  // handed to a stranger at Apple.
  const weak = (p, label) => {
    const bad = ['password', 'test', 'porchpay', 'demo', 'letmein', '12345678', 'qwerty', 'admin'];
    if (p.length < 10) return `${label} is only ${p.length} characters — use at least 10.`;
    if (bad.some(w => p.toLowerCase().includes(w))) return `${label} contains a word anyone would guess first.`;
    if (!/[^A-Za-z]/.test(p)) return `${label} is letters only — add a number or symbol.`;
    return null;
  };
  const problems = [weak(BUYER_PW, 'The buyer password'), weak(ADMIN_PW, 'The servicer password'),
    BUYER_PW === ADMIN_PW ? 'Both passwords are the same — guessing one would give away the admin site too.' : null,
  ].filter(Boolean);
  if (problems.length) {
    console.error('\nNothing was created. Fix these and run it again:\n');
    for (const p of problems) console.error('  - ' + p);
    console.error('');
    process.exit(1);
  }

  await api('/api/signup', { method: 'POST', body: JSON.stringify({
    company_name: COMPANY, name: 'Demo Servicing', email: ADMIN_EMAIL, password: ADMIN_PW,
    signup_token: SIGNUP_TOKEN || undefined }) });
  console.log('company created');

  await api('/api/admin/company', { method: 'PUT', body: JSON.stringify({
    company_name: COMPANY, mgmt_company_name: COMPANY,
    company_email: 'support@porchpay.app', company_phone: '810-555-0142',
    company_address: '1 Saginaw St', company_city: 'Flint', company_state: 'MI', company_zip: '48502' }) });

  const prop = await api('/api/admin/properties', { method: 'POST', body: JSON.stringify({
    ...ADDRESS, beds: 3, baths: 2, sqft: 1460, purchase_price_cents: 5_400_000 }) });

  const buyer = await api('/api/admin/tenants', { method: 'POST', body: JSON.stringify({
    name: BUYER_NAME, email: BUYER_EMAIL, phone: '810-555-0188' }) });

  const first = monthsAgo(MONTHS_PAID);
  const { loan } = await api('/api/admin/loans', { method: 'POST', body: JSON.stringify({
    property_id: prop.id, tenant_user_id: buyer.id, loan_type: 'land_contract',
    sale_price_cents: SALE_PRICE, down_payment_cents: DOWN, principal_cents: PRINCIPAL,
    interest_rate_bps: RATE_BPS, term_months: TERM_MONTHS, escrow_cents: ESCROW,
    late_fee_cents: 5000, grace_days: 10, first_payment_date: iso(first) }) });
  console.log(`loan ${loan.id} created — payment $${(loan.payment_cents / 100).toFixed(2)}/mo`);

  // Seven years of on-time payments. Only the manual methods can be posted by hand —
  // card and bank rows come from Stripe — and check, Zelle and the occasional cash
  // payment is what a land contract actually looks like.
  const due = loan.payment_cents + ESCROW;
  const METHODS = ['check', 'check', 'zelle', 'check', 'zelle', 'cash'];
  // Every due date from the first one through this month. Miss either end and the loan
  // sits permanently one payment behind: the app opens on a red past-due banner and the
  // engine files a partial-payment receipt against every single month, which is both
  // wrong and the worst thing a reviewer of a lending app could open the product on.
  for (let i = 0; i <= MONTHS_PAID; i++) {
    const d = monthsAgo(MONTHS_PAID - i);
    await api(`/api/admin/loans/${loan.id}/payments`, { method: 'POST', body: JSON.stringify({
      amount_cents: due, entry_date: iso(d), method: METHODS[i % METHODS.length] }) });
  }
  console.log(`${MONTHS_PAID + 1} payments posted, every due date through this month`);

  // The four folders a buyer actually opens.
  const docs = [
    ['loan_docs', 'Land Contract — 8800 Crestwood Ln', 'land-contract.pdf', [
      'LAND CONTRACT', '', 'Seller: Porch Pay Demo Servicing', `Purchaser: ${BUYER_NAME}`,
      `Property: ${ADDRESS.address}, ${ADDRESS.city}, ${ADDRESS.state} ${ADDRESS.zip}`, '',
      `Purchase price: $${(SALE_PRICE / 100).toLocaleString()}`,
      `Down payment: $${(DOWN / 100).toLocaleString()}`,
      `Amount financed: $${(PRINCIPAL / 100).toLocaleString()}`,
      'Interest rate: 9.50% per annum', `Term: ${TERM_MONTHS} months`,
      '', 'This is a sample document for App Store review.']],
    ['insurance', 'Homeowner Insurance — Declarations Page', 'insurance-declarations.pdf', [
      'HOMEOWNER INSURANCE — DECLARATIONS', '', `Insured: ${BUYER_NAME}`,
      `Property: ${ADDRESS.address}`, 'Policy number: HO-4471902',
      'Dwelling coverage: $180,000', 'Annual premium: $1,284.00',
      'Escrowed monthly: $107.00', '', 'This is a sample document for App Store review.']],
    ['taxes', 'Property Tax Statement — Summer', 'tax-statement-summer.pdf', [
      'CITY OF FLINT — SUMMER TAX STATEMENT', '', `Parcel: 41-08-800-042`,
      `Property: ${ADDRESS.address}`, 'Taxable value: $54,200',
      'Summer levy: $874.16', 'Paid from escrow', '',
      'This is a sample document for App Store review.']],
    ['closing_receipts', 'Closing Statement', 'closing-statement.pdf', [
      'CLOSING STATEMENT', '', `Purchaser: ${BUYER_NAME}`, `Property: ${ADDRESS.address}`,
      `Closing date: ${iso(first)}`, '',
      `Down payment received: $${(DOWN / 100).toLocaleString()}`,
      'Recording fee: $30.00', 'Title work: $425.00', '',
      'This is a sample document for App Store review.']],
  ];
  for (const [category, title, filename, lines] of docs) {
    await api('/api/admin/documents', { method: 'POST', body: JSON.stringify({
      filename, mime: 'application/pdf', data_base64: pdf(title, lines),
      kind: 'closing', category, title, loan_id: loan.id,
      property_id: prop.id, visible_to_tenant: 1 }) });
  }
  console.log(`${docs.length} documents filed and shared with the buyer`);

  try {
    await api(`/api/admin/loans/${loan.id}/messages`, { method: 'POST', body: JSON.stringify({
      body: `Hi ${BUYER_NAME.split(' ')[0]} — your escrow review for this year is done. `
        + `The summer tax bill came in slightly lower than last year, so your monthly escrow drops `
        + `by $4.10 starting next month. The updated statement is in your Documents tab under Taxes. `
        + `Nothing you need to do.` }) });
    console.log('message thread started');
  } catch (e) { console.log('message thread skipped:', e.message); }

  // The buyer's first sign-in, done here so the reviewer never meets the
  // change-password or accept-terms screens and can go straight into the app.
  const login = await fetch(BASE + '/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: BUYER_EMAIL, password: buyer.temp_password }) });
  const bCookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const asBuyer = (p, body) => fetch(BASE + p, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: bCookie }, body: JSON.stringify(body) });
  await asBuyer('/api/change-password', { password: BUYER_PW });
  await asBuyer('/api/tenant/accept-terms', { accept_terms: true, accept_privacy: true });

  const shown = (p) => CHOSE_OWN ? '(the one you chose)' : p;
  console.log(`
================================================================
  Give these to Apple under "Sign-In Required"
================================================================

  Username   ${BUYER_EMAIL}
  Password   ${shown(BUYER_PW)}

  Servicer login (yours, not Apple's) — porchpay.../admin
  Username   ${ADMIN_EMAIL}
  Password   ${shown(ADMIN_PW)}
${CHOSE_OWN ? '' : '\n  Save both now — they are not written to any file.\n'}
  Sign in as the buyer and take the six screenshots:
  Home, Pay, My Loan, Documents, Payment History, Messages.
================================================================
`);
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
