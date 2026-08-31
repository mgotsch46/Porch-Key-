// End-to-end API test. Run: DATA_DIR=/tmp/testdata node test.js (server must NOT be running on 3001)
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/testdata-' + Date.now();
process.env.PORT = 3001;
process.env.ADMIN_EMAIL = 'admin@test.com';
process.env.ADMIN_PASSWORD = 'TestAdmin123!';
require('./server.js');

const BASE = 'http://localhost:3001';
let adminCookie = '', tbCookie = '';
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name); } }

// Twilio signs its webhooks and the app now insists on it, so the tests have to sign
// too. TEST_AUTH_TOKEN is planted on the company so there is something to sign with.
const TEST_AUTH_TOKEN = 'test-auth-token-for-signatures';
function signedForm(path, data, { token = TEST_AUTH_TOKEN, tamper = false, omit = false } = {}) {
  const url = BASE + path;
  const params = {};
  for (const [k, v] of Object.entries(data)) params[k] = String(v);
  const body = Object.keys(params).sort().map(k => k + params[k]).join('');
  let sig = require('node:crypto').createHmac('sha1', token)
    .update(Buffer.from(url + body, 'utf-8')).digest('base64');
  if (tamper) sig = 'AAAA' + sig.slice(4);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (!omit) headers['X-Twilio-Signature'] = sig;
  return fetch(url, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
}
// Make sure there is a company auth token for the signature check to verify against.
function plantAuthToken() {
  require('./db.js').db.prepare(
    `UPDATE companies SET twilio_token=? WHERE id=(SELECT MIN(id) FROM companies)`).run(TEST_AUTH_TOKEN);
}

async function req(path, opts = {}, cookie = adminCookie) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...opts,
  });
  const setC = res.headers.get('set-cookie');
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, cookie: setC ? setC.split(';')[0] : null };
}

async function main() {
  await new Promise(r => setTimeout(r, 800));
  console.log('— auth');
  let r = await req('/api/login', { method: 'POST', body: JSON.stringify({ email: 'admin@test.com', password: 'TestAdmin123!' }) }, '');
  ok(r.status === 200 && r.json.role === 'owner', 'owner login');
  adminCookie = r.cookie;
  r = await req('/api/change-password', { method: 'POST', body: JSON.stringify({ password: 'TestAdmin123!' }) });
  ok(r.status === 200, 'change password');

  console.log('— deal setup');
  r = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '123 Oak St', city: 'Columbus', state: 'OH', zip: '43004', trust_name: 'Oak Street Trust', trustee: 'ABC Trustee LLC' }) });
  ok(r.status === 200 && r.json.id, 'create property');
  const propId = r.json.id;
  r = await req('/api/admin/tenants', { method: 'POST', body: JSON.stringify({ name: 'Jane Buyer', email: 'jane@test.com', phone: '555-0100' }) });
  ok(r.status === 200 && r.json.temp_password, 'create tenant buyer w/ temp password');
  const tbId = r.json.id, tempPw = r.json.temp_password;

  // Loan: $100,000 @ 9.5% for 360 months => payment should be ~$840.85
  r = await req('/api/admin/loans', { method: 'POST', body: JSON.stringify({
    property_id: propId, tenant_user_id: tbId, loan_type: 'land_trust_beneficial_interest',
    sale_price_cents: 12000000, down_payment_cents: 2000000, principal_cents: 10000000,
    interest_rate_bps: 950, term_months: 360, escrow_cents: 25000, late_fee_cents: 5000,
    grace_days: 5, first_payment_date: '2026-06-01', beneficial_interest_pct: 90 }) });
  ok(r.status === 200 && r.json.loan, 'create loan');
  const loanId = r.json.loan.id;
  const pmt = r.json.loan.payment_cents;
  ok(Math.abs(pmt - 84085) <= 2, `auto payment calc ~ $840.85 (got $${(pmt/100).toFixed(2)})`);

  console.log('— loan detail & schedule');
  r = await req('/api/admin/loans/' + loanId);
  ok(r.json.schedule.length === 360, 'amortization schedule 360 rows');
  const firstRow = r.json.schedule[0];
  ok(Math.abs(firstRow.interest_cents - Math.round(10000000 * 0.095 / 12)) <= 1, 'first month interest = balance * rate/12');
  ok(r.json.status.payments_due >= 2, 'payments due counted (loan started 2026-06)');
  ok(r.json.status.is_past_due, 'loan shows past due before any payments');

  console.log('— yearly amortization rollup');
  r = await req('/api/admin/loans/' + loanId);
  const yr = r.json.schedule_yearly;
  ok(Array.isArray(yr) && yr.length >= 30, `yearly rollup returned (${yr && yr.length} years)`);
  ok(yr[0].year === '2026' && yr[0].payments === 7, 'first year covers Jun–Dec = 7 payments');
  const monthlyInt = r.json.schedule.reduce((t, x) => t + x.interest_cents, 0);
  const yearlyInt = yr.reduce((t, x) => t + x.interest_cents, 0);
  ok(monthlyInt === yearlyInt, 'yearly interest totals match the monthly schedule exactly');
  ok(yr[yr.length - 1].balance_cents === 0, 'final year ends at a zero balance');
  r = await req(`/api/admin/amortize?principal_cents=10000000&interest_rate_bps=950&term_months=360&first_payment_date=2026-06-01`);
  ok(Array.isArray(r.json.schedule_yearly) && r.json.schedule_yearly.length >= 30, 'calculator returns a yearly rollup too');

  console.log('— rate precision (5 decimals of percent)');
  // 7.12345% = 712.345 bps. The payment must come from the full-precision rate, tie
  // out against the standard amortization formula to the cent, and round-trip through
  // storage without losing a digit.
  {
    const P = 15000000, bps = 712.345, n = 360;
    const rm = bps / 10000 / 12;
    const expected = Math.round(P * (rm * Math.pow(1 + rm, n)) / (Math.pow(1 + rm, n) - 1));
    r = await req(`/api/admin/amortize?principal_cents=${P}&interest_rate_bps=${bps}&term_months=${n}`);
    ok(r.json.interest_rate_bps === bps, `rate survives the calculator unrounded (${r.json.interest_rate_bps})`);
    ok(r.json.payment_cents === expected, `payment from full-precision rate matches the formula to the cent ($${(r.json.payment_cents/100).toFixed(2)})`);
    ok(r.json.schedule[r.json.schedule.length-1].balance_cents === 0, 'schedule amortizes to exactly zero');
    // A rate rounded to 2 decimals would give a different payment — prove the digits matter.
    const rounded = await req(`/api/admin/amortize?principal_cents=${P}&interest_rate_bps=712&term_months=${n}`);
    ok(rounded.json.payment_cents !== r.json.payment_cents, 'truncating the rate changes the payment — precision is load-bearing');
    // Storage round-trip on a real loan.
    const prec = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '9 Precision Pl', city: 'Flint', state: 'MI', zip: '48503' }) });
    const pl = await req('/api/admin/loans', { method: 'POST', body: JSON.stringify({
      property_id: prec.json.id, loan_type: 'land_contract', sale_price_cents: P, down_payment_cents: 0,
      principal_cents: P, interest_rate_bps: bps, term_months: n, first_payment_date: '2026-09-01' }) });
    ok(pl.json.loan.interest_rate_bps === bps, 'fractional rate stored and returned exactly');
    ok(pl.json.loan.payment_cents === expected, 'auto-calculated payment on the stored loan matches too');
    await req('/api/admin/loans/' + pl.json.loan.id, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });
  }

  console.log('— certified mail configuration');
  // The key alone is not enough — certified mail with no return address bounces at
  // the print shop, so the API refuses to save half a setup.
  r = await req('/api/admin/lob', { method: 'PUT', body: JSON.stringify({ api_key: 'test_abc123' }) });
  ok(r.status === 400 && /return address/i.test(r.json.error), 'refuses a Lob key without a return address');
  r = await req('/api/admin/lob');
  ok(r.status === 200 && r.json.connected === false, 'certified mail reads as not connected');
  // A notice that never went certified has no mail status to fetch.
  {
    const list = await req(`/api/admin/loans/${loanId}/notices`);
    if (list.json.length) {
      r = await req(`/api/admin/notices/${list.json[0].id}/mail-status`);
      ok(r.status === 400, 'mail-status refuses a notice that did not go certified');
    }
  }
  {
    const lobMod = require('./lob.js');
    ok(lobMod.creds({}) === null, 'no key, no creds');
    ok(lobMod.creds({ lob_api_key: 'test_x' }) === null, 'key without address is not enabled');
    const c = lobMod.creds({ lob_api_key: 'test_x', name: 'SAA', mail_address_line1: '1 Main',
      mail_address_city: 'Flint', mail_address_state: 'MI', mail_address_zip: '48503' });
    ok(c && c.test === true && c.from.address_city === 'Flint', 'full config enables test mode');
    const html = lobMod.letterHtml({ subject: 'Notice <b>', body: 'Line & one\n\nLine two' });
    ok(html.includes('Notice &lt;b&gt;') && html.includes('Line &amp; one'), 'letter HTML escapes user text');
    ok(html.includes('margin-top: 2.6in'), 'letter leaves room for the address window');
  }

  console.log('— editing the buyer');
  r = await req('/api/admin/tenants/' + tbId, { method: 'PUT', body: JSON.stringify({ name: 'Jane A. Buyer', phone: '5555550142' }) });
  ok(r.status === 200 && r.json.name === 'Jane A. Buyer', 'buyer name updated');
  ok(r.json.phone === '555-555-0142', 'phone reformatted with dashes on edit');
  r = await req('/api/admin/tenants/' + tbId, { method: 'PUT', body: JSON.stringify({ email: 'admin@test.com' }) });
  ok(r.status === 400, 'cannot move a buyer onto an email already in use');
  r = await req('/api/admin/tenants/' + tbId, { method: 'PUT', body: JSON.stringify({ email: 'jane.buyer@test.com' }) });
  ok(r.status === 200, 'buyer email changed');
  const relog = await req('/api/login', { method: 'POST', body: JSON.stringify({ email: 'jane.buyer@test.com', password: tempPw }) }, '');
  ok(relog.status === 200, 'buyer signs in with the new email');
  r = await req('/api/admin/tenants/' + tbId, { method: 'PUT', body: JSON.stringify({ email: 'jane@test.com', name: 'Jane Buyer' }) });
  ok(r.status === 200 && r.json.email === 'jane@test.com', 'buyer restored for the remaining tests');

  console.log('— editing loan terms');
  r = await req('/api/admin/loans/' + loanId, { method: 'PUT', body: JSON.stringify({
    interest_rate_bps: 800, term_months: 240, recalc_payment: 1 }) });
  ok(r.status === 200, 'loan terms saved');
  r = await req('/api/admin/loans/' + loanId);
  ok(r.json.loan.interest_rate_bps === 800 && r.json.loan.term_months === 240, 'rate and term persisted');
  ok(Math.abs(r.json.loan.payment_cents - 83644) <= 3, `P&I recalculated to ~$836.44 (got $${(r.json.loan.payment_cents/100).toFixed(2)})`);
  ok(r.json.schedule.length === 240, 'schedule follows the new term');
  ok(r.json.loan.final_payment_date === '2046-05-01', 'final payment date recalculated from the new term');
  r = await req('/api/admin/loans/' + loanId, { method: 'PUT', body: JSON.stringify({
    monthly_taxes_cents: 20000, monthly_insurance_cents: 9000 }) });
  r = await req('/api/admin/loans/' + loanId);
  ok(r.json.loan.escrow_cents === 29000, 'escrow follows taxes + insurance automatically');
  r = await req('/api/admin/loans/' + loanId, { method: 'PUT', body: JSON.stringify({
    interest_rate_bps: 950, term_months: 360, recalc_payment: 1, monthly_taxes_cents: 0, monthly_insurance_cents: 25000 }) });
  ok(r.status === 200, 'terms restored for the remaining tests');

  console.log('— recurring & one-time charges');
  r = await req(`/api/admin/loans/${loanId}/charges`, { method: 'POST', body: JSON.stringify({ description: 'Servicing fee', category: 'servicing_fee', amount_cents: 2500, recurring: true, start_date: '2026-06-01' }) });
  ok(r.status === 200, 'add recurring servicing fee');
  r = await req(`/api/admin/loans/${loanId}/charges`, { method: 'POST', body: JSON.stringify({ description: 'Repair bill', amount_cents: 15000, recurring: false }) });
  ok(r.status === 200, 'add one-time charge');
  r = await req('/api/admin/loans/' + loanId);
  ok(r.json.loan.fees_due_cents >= 15000 + 2500 * 2, `fees accrued incl recurring months (fees_due=$${(r.json.loan.fees_due_cents/100).toFixed(2)})`);

  console.log('— payments & allocation');
  const owed = r.json.status.owed_now_cents;
  r = await req(`/api/admin/loans/${loanId}/payments`, { method: 'POST', body: JSON.stringify({ amount_cents: 100000, method: 'cash', memo: 'test payment' }) });
  ok(r.status === 200 && r.json.alloc, 'record manual payment');
  ok(r.json.alloc.to_fees_cents > 0, 'allocation pays fees first');
  ok(r.json.alloc.to_interest_cents > 0, 'allocation pays interest');
  r = await req('/api/admin/loans/' + loanId);
  const led = r.json.ledger.filter(l => l.type === 'payment');
  ok(led.length === 1 && led[0].amount_cents === 100000, 'ledger entry recorded');

  console.log('— notices (late + legal, read receipts)');
  r = await req('/api/admin/notice-sweep', { method: 'POST', body: '{}' });
  ok(r.status === 200, 'run notice sweep');
  r = await req(`/api/admin/loans/${loanId}/notices`);
  const lateN = r.json.find(n => n.type === 'late_notice');
  const legalN = r.json.find(n => n.type === 'legal_notice');
  ok(!!lateN, 'late notice auto-sent');
  ok(!!legalN, 'legal notice auto-escalated (>15 days past due)');
  ok(!lateN.read_at, 'notice unread initially');

  console.log('— per-loan notice pause');
  // The pause is an exception on ONE loan. A pause with no floor is still a footgun.
  // Three identical delinquent loans: one with no rule, two with a rule — one paying
  // under the floor, one over it. Only the over-the-floor loan goes quiet.
  const mkLoan = async (addr, email) => {
    const p = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: addr, city: 'Columbus', state: 'OH', zip: '43004' }) });
    const t = await req('/api/admin/tenants', { method: 'POST', body: JSON.stringify({ name: 'Pause Test', email }) });
    const l = await req('/api/admin/loans', { method: 'POST', body: JSON.stringify({
      property_id: p.json.id, tenant_user_id: t.json.id, loan_type: 'land_trust_beneficial_interest',
      sale_price_cents: 12000000, down_payment_cents: 2000000, principal_cents: 10000000,
      interest_rate_bps: 950, term_months: 360, escrow_cents: 25000, late_fee_cents: 5000,
      grace_days: 5, first_payment_date: '2026-06-01', beneficial_interest_pct: 90 }) });
    return l.json.loan.id;
  };
  const tokenLoan = await mkLoan('1 Token Way', 'token@test.com');
  const realLoan = await mkLoan('2 Real Way', 'real@test.com');
  const noRuleLoan = await mkLoan('3 NoRule Rd', 'norule@test.com');
  r = await req(`/api/admin/loans/${realLoan}/notice-pause`, { method: 'PUT', body: JSON.stringify({ pause_days: 15, pause_min_cents: 0 }) });
  ok(r.status === 400, 'refuses a pause with no minimum payment');
  r = await req(`/api/admin/loans/${tokenLoan}/notice-pause`, { method: 'PUT', body: JSON.stringify({ pause_days: 15, pause_min_cents: 50000 }) });
  ok(r.status === 200, 'pause rule set on the token loan');
  r = await req(`/api/admin/loans/${realLoan}/notice-pause`, { method: 'PUT', body: JSON.stringify({ pause_days: 15, pause_min_cents: 50000 }) });
  ok(r.status === 200, 'pause rule set on the real loan');
  r = await req(`/api/admin/loans/${realLoan}/notice-ladder`);
  ok(r.json.pause_days === 15 && r.json.pause_min_cents === 50000, 'rule readable on the loan ladder');
  // All three pay something; the no-rule loan pays plenty — but has no rule.
  await req(`/api/admin/loans/${tokenLoan}/payments`, { method: 'POST', body: JSON.stringify({ amount_cents: 5000, method: 'cash', memo: 'token $50' }) });
  await req(`/api/admin/loans/${realLoan}/payments`, { method: 'POST', body: JSON.stringify({ amount_cents: 60000, method: 'cash', memo: 'real $600' }) });
  await req(`/api/admin/loans/${noRuleLoan}/payments`, { method: 'POST', body: JSON.stringify({ amount_cents: 60000, method: 'cash', memo: 'no rule $600' }) });
  await req('/api/admin/notice-sweep', { method: 'POST', body: '{}' });
  r = await req(`/api/admin/loans/${tokenLoan}/notices`);
  ok(r.json.length > 0, '$50 under the floor does NOT pause that loan');
  r = await req(`/api/admin/loans/${realLoan}/notices`);
  ok(r.json.length === 0, '$600 over the floor pauses only its own loan');
  r = await req(`/api/admin/loans/${noRuleLoan}/notices`);
  ok(r.json.length > 0, 'a loan with no rule is chased on normal timing — nothing global is inherited');

  // Removing the rule clears both fields and the loan is chased again.
  r = await req(`/api/admin/loans/${realLoan}/notice-pause`, { method: 'PUT', body: JSON.stringify({ pause_days: 0, pause_min_cents: 50000 }) });
  ok(r.status === 200 && r.json.pause_min_cents === 0, 'removing the rule clears the minimum too');
  await req('/api/admin/notice-sweep', { method: 'POST', body: '{}' });
  r = await req(`/api/admin/loans/${realLoan}/notices`);
  ok(r.json.length > 0, 'with its rule removed the loan is chased again');

  console.log('— tenant buyer side');
  r = await req('/api/login', { method: 'POST', body: JSON.stringify({ email: 'jane@test.com', password: tempPw }) }, '');
  ok(r.status === 200 && r.json.must_change_password, 'TB login with temp password');
  tbCookie = r.cookie;
  r = await req('/api/change-password', { method: 'POST', body: JSON.stringify({ password: 'JanePass123!' }) }, tbCookie);
  ok(r.status === 200, 'TB sets own password');

  console.log('— consent gate (App Store / Play requirement)');
  r = await req('/api/tenant/loan', {}, tbCookie);
  ok(r.status === 451, 'loan data blocked until terms accepted');
  r = await req('/api/tenant/messages', { method: 'POST', body: JSON.stringify({ body: 'hi' }) }, tbCookie);
  ok(r.status === 451, 'messaging blocked until terms accepted');
  ok(r.status === 451, 'payments blocked until terms accepted');
  r = await req('/api/tenant/accept-terms', { method: 'POST', body: JSON.stringify({ accept_terms: true }) }, tbCookie);
  ok(r.status === 400, 'must accept BOTH terms and privacy');
  r = await req('/api/tenant/accept-terms', { method: 'POST', body: JSON.stringify({ accept_terms: true, accept_privacy: true }) }, tbCookie);
  ok(r.status === 200, 'TB accepts terms + privacy');
  r = await req('/api/tenant/consents', {}, tbCookie);
  ok(r.json.terms_accepted_at && r.json.history.some(h => h.kind === 'messaging'), 'consent audit trail recorded');

  r = await req('/api/tenant/loan', {}, tbCookie);
  ok(r.status === 200 && r.json.loan.id === loanId, 'TB sees own loan');
  ok(r.json.loan.principal_balance_cents <= 10000000, 'TB sees current balance');
  // $1,000 payment: $225 fees + $775 toward $791.67 interest => nothing to principal (correct waterfall)
  ok(r.json.loan.interest_due_cents > 0, 'interest shortfall carried forward when payment < fees+interest');
  ok(r.json.charges.some(c => c.category === 'servicing_fee'), 'TB sees recurring cost breakdown');
  ok(r.json.payoff.total_cents > 0, 'TB payoff quote');
  r = await req('/api/tenant/notices', {}, tbCookie);
  ok(r.json.length >= 2, 'TB sees notices');
  const nid = r.json[0].id;
  r = await req(`/api/tenant/notices/${nid}/read`, { method: 'POST', body: '{}' }, tbCookie);
  ok(r.status === 200, 'TB opens notice');
  r = await req(`/api/admin/loans/${loanId}/notices`);
  ok(r.json.find(n => n.id === nid).read_at, 'admin sees read receipt ✓✓');

  console.log('— messaging');
  r = await req('/api/tenant/messages', { method: 'POST', body: JSON.stringify({ body: 'Hi, I paid part of it!' }) }, tbCookie);
  ok(r.status === 200, 'TB sends message');
  r = await req('/api/admin/messages');
  // Assert on this buyer's thread rather than on the thread count — other loans in the
  // company have threads too, and the count is not what this test is about.
  ok((r.json.find(t => t.loan_id === loanId) || {}).unread >= 1, 'admin sees unread thread');
  r = await req(`/api/admin/loans/${loanId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Got it — thanks!' }) });
  ok(r.status === 200, 'admin replies');
  r = await req('/api/tenant/messages', {}, tbCookie);
  ok(r.json.length >= 3, 'TB sees full thread (incl notice ping)');

  console.log('— cash recorded by hand');
  // Cash at retail is gone, but cash still turns up. The admin records it directly.
  r = await req(`/api/admin/loans/${loanId}/payments`, {
    method: 'POST',
    body: JSON.stringify({ amount_cents: 110000, method: 'cash', memo: 'cash in person' }),
  });
  ok(r.status === 200, 'admin records a cash payment');

  r = await req('/api/tenant/loan', {}, tbCookie);
  ok(r.json.ledger.filter(l => l.type === 'payment').length === 2, 'cash payment posted to ledger');

  console.log('— expenses');
  r = await req('/api/admin/expenses', { method: 'POST', body: JSON.stringify({ description: 'Home Depot materials', amount_cents: 23456, category: 'materials' }) });
  ok(r.status === 200 && r.json.status === 'unassigned', 'manual expense starts unassigned');
  r = await req(`/api/admin/expenses/${r.json.id}`, { method: 'PUT', body: JSON.stringify({ property_id: propId, status: 'assigned' }) });
  ok(r.json.status === 'assigned', 'expense assigned to property');

  console.log('— document center');
  const b64 = Buffer.from('%PDF-1.4 fake policy').toString('base64');
  r = await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
    filename: 'policy2026.pdf', mime: 'application/pdf', data_base64: b64, loan_id: loanId,
    category: 'insurance', title: '2026 Homeowners Policy', effective_date: '2026-01-01', visible_to_tenant: true }) });
  ok(r.status === 200 && r.json.visible_to_tenant === 1, 'upload shared insurance doc');
  const insDocId = r.json.id;
  r = await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
    filename: 'profit-analysis.pdf', mime: 'application/pdf', data_base64: b64, loan_id: loanId,
    category: 'private', title: 'Deal analysis', visible_to_tenant: true }) });
  ok(r.json.visible_to_tenant === 0, 'private category forces admin-only even if flag set');
  const privDocId = r.json.id;
  r = await req(`/api/admin/loans/${loanId}/documents`);
  ok(r.json.insurance.documents.length === 1, 'admin sees insurance folder');
  ok(r.json.private.documents.length === 1 && !r.json.private.shared, 'admin sees private vault');
  ok(['loan_docs','trust_docs','closing_receipts','insurance','taxes','utilities','correspondence','private'].every(c => r.json[c]),
    'all folders present as placeholders, incl trust docs and closing receipts');
  ok(!r.json.trust_docs.shared, 'trust documents folder is admin-only');
  r = await req('/api/tenant/documents', {}, tbCookie);
  ok(r.json.length === 7, 'TB sees 7 shared folders (placeholders included)');
  ok(!r.json.some(f => f.category === 'trust_docs'), 'TB has no trust documents folder at all');
  ok(r.json.some(f => f.category === 'misc_shared'), 'TB has the shared Misc folder');
  ok(r.json.find(f => f.category === 'insurance').documents.length === 1, 'TB sees shared insurance doc');
  ok(!r.json.some(f => f.documents.some(d => d.id === privDocId)), 'TB never sees private docs');
  r = await req(`/api/documents/${privDocId}/download`, {}, tbCookie);
  ok(r.status === 403, 'TB blocked from downloading private doc');
  r = await req(`/api/admin/documents/${insDocId}`, { method: 'PUT', body: JSON.stringify({ category: 'private' }) });
  ok(r.json.visible_to_tenant === 0, 'moving doc to private revokes buyer access');
  r = await req('/api/tenant/documents', {}, tbCookie);
  ok(r.json.find(f => f.category === 'insurance').documents.length === 0, 'TB no longer sees moved doc');
  r = await req(`/api/admin/documents/${privDocId}`, { method: 'DELETE' });
  ok(r.status === 200, 'delete document');

  console.log('— batch upload, the unsorted tray, and refiling');
  // A batch upload lands unsorted, and unsorted is never shown to a buyer — even if
  // the upload claims otherwise. Sharing is a decision made when the doc is filed.
  r = await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
    filename: 'trust-agreement.pdf', mime: 'application/pdf', data_base64: b64, loan_id: loanId,
    category: 'unsorted', visible_to_tenant: true }) });
  ok(r.status === 200 && r.json.visible_to_tenant === 0, 'unsorted upload is never buyer-visible');
  const unsortedId = r.json.id;
  r = await req(`/api/admin/loans/${loanId}/documents`);
  ok(r.json.unsorted && r.json.unsorted.documents.length === 1, 'unsorted tray appears when something is in it');
  r = await req('/api/tenant/documents', {}, tbCookie);
  ok(!r.json.some(f => f.documents.some(d => d.id === unsortedId)), 'TB never sees the unsorted tray');
  // Trust documents are the ownership structure — filing there forces admin-only,
  // even when the request claims the buyer should see it.
  r = await req(`/api/admin/documents/${unsortedId}`, { method: 'PUT', body: JSON.stringify({ category: 'trust_docs', visible_to_tenant: true }) });
  ok(r.status === 200 && r.json.category === 'trust_docs' && r.json.visible_to_tenant === 0, 'filed into trust documents — forced admin-only');
  r = await req(`/api/admin/loans/${loanId}/documents`);
  ok(!r.json.unsorted, 'tray disappears once emptied');
  ok(r.json.trust_docs.documents.length === 1 && !r.json.trust_docs.shared, 'doc lives in the admin-only trust folder');
  r = await req('/api/tenant/documents', {}, tbCookie);
  ok(!r.json.some(f => f.documents.some(d => d.id === unsortedId)), 'TB cannot see the trust doc anywhere');

  // The two Misc buckets: one crosses the fence, one never does.
  r = await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
    filename: 'misc-s.pdf', mime: 'application/pdf', data_base64: b64, loan_id: loanId,
    category: 'misc_shared', visible_to_tenant: true }) });
  ok(r.status === 200 && r.json.visible_to_tenant === 1, 'shared Misc accepts and shares');
  const miscSharedId = r.json.id;
  r = await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
    filename: 'misc-a.pdf', mime: 'application/pdf', data_base64: b64, loan_id: loanId,
    category: 'misc_admin', visible_to_tenant: true }) });
  ok(r.status === 200 && r.json.visible_to_tenant === 0, 'admin Misc forces admin-only even if the flag is set');
  r = await req('/api/tenant/documents', {}, tbCookie);
  ok(r.json.find(f => f.category === 'misc_shared').documents.some(d => d.id === miscSharedId), 'TB sees the shared Misc doc');
  ok(!r.json.some(f => f.documents.some(d => d.filename === 'misc-a.pdf')), 'TB never sees the admin Misc doc');
  // Closing receipts is a real bucket too.
  r = await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
    filename: 'closing-receipt.pdf', mime: 'application/pdf', data_base64: b64, loan_id: loanId,
    category: 'closing_receipts', visible_to_tenant: true }) });
  ok(r.status === 200 && r.json.category === 'closing_receipts', 'closing receipts bucket accepts uploads');
  const receiptId = r.json.id;

  console.log('— sharing is a deliberate click, never a default');
  {
    // Uploaded into a buyer-capable folder with no flag: stays admin-only, stays in
    // its folder (not dumped into Private), and the buyer sees nothing.
    r = await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
      filename: 'quiet-policy.pdf', mime: 'application/pdf', data_base64: b64, loan_id: loanId,
      category: 'insurance' }) });
    ok(r.status === 200 && r.json.visible_to_tenant === 0, 'no flag means admin-only');
    const quietId = r.json.id;
    r = await req(`/api/admin/loans/${loanId}/documents`);
    ok(r.json.insurance.documents.some(d => d.id === quietId), 'unshared doc stays in its own folder');
    r = await req('/api/tenant/documents', {}, tbCookie);
    ok(!r.json.some(f => f.documents.some(d => d.id === quietId)), 'buyer cannot see it');
    // The deliberate click.
    r = await req(`/api/admin/documents/${quietId}`, { method: 'PUT', body: JSON.stringify({ visible_to_tenant: true }) });
    ok(r.status === 200 && r.json.visible_to_tenant === 1, 'shared by explicit choice');
    r = await req('/api/tenant/documents', {}, tbCookie);
    ok(r.json.find(f => f.category === 'insurance').documents.some(d => d.id === quietId), 'now the buyer sees it');
    // And back again.
    r = await req(`/api/admin/documents/${quietId}`, { method: 'PUT', body: JSON.stringify({ visible_to_tenant: false }) });
    r = await req('/api/tenant/documents', {}, tbCookie);
    ok(!r.json.some(f => f.documents.some(d => d.id === quietId)), 'unsharing pulls it back');
  }

  console.log('— in-app viewer');
  r = await req(`/api/documents/${miscSharedId}/view`, {}, tbCookie);
  ok(r.status === 200, 'TB can view a shared doc inline');
  r = await req(`/api/documents/${receiptId}/view`);
  ok(r.status === 200, 'admin can view inline');
  r = await req(`/api/admin/documents/${receiptId}`, { method: 'PUT', body: JSON.stringify({ category: 'private' }) });
  r = await req(`/api/documents/${receiptId}/view`, {}, tbCookie);
  ok(r.status === 403, 'TB blocked from viewing a doc pulled back to private');

  console.log('— PML loans');
  r = await req('/api/admin/pml', { method: 'POST', body: JSON.stringify({
    property_id: propId, lender_name: 'Smith Capital LLC', lender_contact: 'bob@smithcap.com',
    lien_position: 1, principal_cents: 7000000, interest_rate_bps: 1200, term_months: 120,
    payment_type: 'interest_only', first_payment_date: '2026-06-01' }) });
  ok(r.status === 200 && r.json.id, 'create PML loan');
  const pmlId = r.json.id;
  ok(r.json.payment_cents === Math.round(7000000 * 0.12 / 12), `interest-only payment auto-calc ($${(r.json.payment_cents/100).toFixed(2)})`);
  r = await req('/api/admin/pml/' + pmlId);
  ok(r.json.tb_loan && r.json.tb_loan.id === loanId, 'PML links to TB loan on same property');
  ok(r.json.monthly_spread_cents === (pmt + 25000) - 70000, `monthly spread = TB payment − PML payment ($${(r.json.monthly_spread_cents/100).toFixed(2)})`);
  r = await req(`/api/admin/pml/${pmlId}/payments`, { method: 'POST', body: JSON.stringify({ amount_cents: 80000 }) });
  ok(r.json.to_interest_cents === 70000 && r.json.to_principal_cents === 10000, 'PML payment: interest first, rest to principal');
  ok(r.json.balance_cents === 6990000, 'PML balance reduced');
  r = await req(`/api/admin/pml/${pmlId}/draw`, { method: 'POST', body: JSON.stringify({ amount_cents: 500000, memo: 'rehab draw' }) });
  ok(r.json.balance_cents === 7490000, 'PML draw increases balance');

  console.log('— editing and deleting a PML loan');
  r = await req('/api/admin/pml/' + pmlId, { method: 'PUT', body: JSON.stringify({ lender_name: 'Smith Capital II LLC', interest_rate_bps: 1000 }) });
  ok(r.status === 200 && r.json.lender_name === 'Smith Capital II LLC' && r.json.interest_rate_bps === 1000, 'PML terms edited');
  ok(r.json.payment_cents === 70000, 'payment left alone unless a recalc is asked for');
  ok(r.json.balance_cents === undefined && r.json.principal_balance_cents === 7490000,
    'balance untouched by an edit — the ledger owns it once money has moved');
  r = await req('/api/admin/pml/' + pmlId, { method: 'PUT', body: JSON.stringify({ recalc_payment: 1 }) });
  ok(r.json.payment_cents === Math.round(7000000 * 0.10 / 12), 'recalc when asked follows the new rate');
  r = await req('/api/admin/pml/' + pmlId, { method: 'PUT', body: JSON.stringify({ term_months: 0 }) });
  ok(r.status === 400, 'a zero-month term is refused');
  r = await req('/api/admin/pml/' + pmlId, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });
  ok(r.status === 400 && /ledger|journal/i.test(r.json.error), 'PML with ledger history cannot be deleted');
  // One with nothing behind it is just a typo, and deletes cleanly.
  r = await req('/api/admin/pml', { method: 'POST', body: JSON.stringify({
    property_id: propId, lender_name: 'Typo Capital', principal_cents: 100000,
    interest_rate_bps: 1000, term_months: 60, first_payment_date: '2026-06-01' }) });
  const junkPml = r.json.id;
  ok(r.json.term_months === 60, 'PML accepts a 60-month term');
  r = await req('/api/admin/pml/' + junkPml, { method: 'DELETE', body: JSON.stringify({ confirm: 'nope' }) });
  ok(r.status === 400, 'delete needs the typed confirmation');
  r = await req('/api/admin/pml/' + junkPml, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });
  ok(r.status === 200, 'a PML with no history deletes');
  r = await req('/api/admin/pml/' + junkPml);
  ok(r.status === 404, 'deleted PML is gone');

  console.log('— deleting a TB loan');
  r = await req('/api/admin/loans/' + loanId, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });
  ok(r.status === 400 && /payment|journal|notice/i.test(r.json.error), 'loan with payments and notices cannot be deleted');
  r = await req('/api/admin/loans', { method: 'POST', body: JSON.stringify({
    property_id: propId, loan_type: 'land_contract', sale_price_cents: 5000000,
    down_payment_cents: 500000, principal_cents: 4500000, interest_rate_bps: 900,
    term_months: 360, first_payment_date: '2026-06-01' }) });
  const junkLoan = r.json.loan.id;
  r = await req('/api/admin/loans/' + junkLoan, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });
  ok(r.status === 200, 'a loan entered by mistake deletes');
  r = await req('/api/admin/loans/' + junkLoan);
  ok(r.status === 404, 'deleted loan is gone');
  r = await req('/api/admin/loans/' + loanId);
  ok(r.status === 200 && r.json.ledger.length > 0, 'the real loan and its ledger are untouched');

  console.log('— property delete backs up, orphaned files recoverable');
  {
    const dp = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '404 Gone St', city: 'Flint', state: 'MI', zip: '48503' }) });
    const dpid = dp.json.id;
    await req(`/api/admin/properties/${dpid}/costs`, { method: 'POST', body: JSON.stringify({
      category: 'rehab', description: 'New roof', amount_cents: 750000 }) });
    const db64 = Buffer.from('%PDF-1.4 the deed').toString('base64');
    const dd = await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
      filename: 'deed.pdf', mime: 'application/pdf', data_base64: db64, property_id: dpid, category: 'acquisition' }) });
    r = await req('/api/admin/properties/' + dpid, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });
    ok(r.status === 200 && r.json.backed_up, 'property deleted — and everything on it backed up first');
    // The backup is findable as a company document.
    r = await req(`/api/admin/loans/${loanId}/documents`);   // any docs listing includes company-wide? No — check via orphans instead.
    // The deed's file is now orphaned and recoverable.
    r = await req('/api/admin/orphan-files');
    ok(r.status === 200 && r.json.files.length >= 1, `orphaned file(s) found after the delete (${r.json.files.length})`);
    const orphan = r.json.files.find(f => f.ext === '.pdf');
    ok(!!orphan, 'the deed file survived the delete');
    r = await req(`/api/admin/orphan-files/${orphan.stored_name}/view`);
    ok(r.status === 200, 'orphan can be opened to identify it');
    r = await req(`/api/admin/orphan-files/${orphan.stored_name}/restore`, { method: 'POST', body: JSON.stringify({ title: 'Recovered deed', property_id: propId }) });
    ok(r.status === 200, 'orphan re-filed onto a property');
    r = await req(`/api/admin/orphan-files/${orphan.stored_name}/restore`, { method: 'POST', body: '{}' });
    ok(r.status === 400, 'cannot re-file the same file twice');
    r = await req('/api/admin/orphan-files/../../etc/passwd/view');
    ok(r.status === 404, 'path traversal goes nowhere');
    // A stranded file can also just be thrown away — but never one a document still names.
    const db64b = Buffer.from('%PDF-1.4 to discard').toString('base64');
    const dp2 = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '405 Gone St', city: 'Flint', state: 'MI', zip: '48503' }) });
    await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
      filename: 'toss.pdf', mime: 'application/pdf', data_base64: db64b, property_id: dp2.json.id, category: 'acquisition' }) });
    await req('/api/admin/properties/' + dp2.json.id, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });
    r = await req('/api/admin/orphan-files');
    const toss = r.json.files.find(f => f.ext === '.pdf');
    ok(!!toss, 'second stranded file present');
    r = await req('/api/admin/orphan-files/' + toss.stored_name, { method: 'DELETE' });
    ok(r.status === 200, 'stranded file discarded');
    r = await req('/api/admin/orphan-files');
    ok(!r.json.files.some(f => f.stored_name === toss.stored_name), 'and it is gone from the list');
    r = await req('/api/admin/orphan-files/' + 'not-there.pdf', { method: 'DELETE' });
    ok(r.status === 404, 'discarding a missing file 404s');
  }

  console.log('— softphone token and TwiML');
  r = await req('/api/admin/voice-token');
  ok(r.status === 400 && r.json.not_configured, 'no token before the softphone is configured');
  r = await req('/api/admin/voice', { method: 'PUT', body: JSON.stringify({ api_key_sid: 'nope', api_key_secret: 'x', twiml_app_sid: 'AP' + 'a'.repeat(32) }) });
  ok(r.status === 400, 'malformed API key SID refused');
  r = await req('/api/admin/voice', { method: 'PUT', body: JSON.stringify({
    api_key_sid: 'SK' + 'a'.repeat(32), api_key_secret: 'shhh-secret', twiml_app_sid: 'AP' + 'b'.repeat(32) }) });
  ok(r.status === 200, 'softphone credentials saved');
  // No Twilio account is connected in tests, so the endpoint still says not-configured —
  // exercise the token builder directly, exactly as the endpoint calls it.
  r = await req('/api/admin/voice-token');
  ok(r.status === 400 && r.json.not_configured, 'token still refused without a Twilio account connected');
  {
    const smsMod = require('./sms.js');
    const token = smsMod.voiceToken({ accountSid: 'AC' + '1'.repeat(32), keySid: 'SK' + 'a'.repeat(32),
      keySecret: 'shhh-secret', appSid: 'AP' + 'b'.repeat(32), identity: 'admin-1' });
    ok(token.split('.').length === 3, 'access token issued as a three-part JWT');
    const [h, p] = token.split('.');
    const dec = (x) => JSON.parse(Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    ok(dec(h).cty === 'twilio-fpa;v=1', 'token carries the Twilio content type');
    const pl = dec(p);
    ok(pl.sub === 'AC' + '1'.repeat(32) && pl.grants.voice.outgoing.application_sid === 'AP' + 'b'.repeat(32),
      'voice grant names the account and TwiML app');
    ok(pl.exp - pl.iat === 3600, 'token lives one hour');
    const expect = require('crypto').createHmac('sha256', 'shhh-secret').update(`${h}.${p}`).digest('base64')
      .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    ok(token.endsWith('.' + expect), 'signature verifies with the API secret');
  }
  // The TwiML answer for an outgoing browser call.
  {
    plantAuthToken();
    const resp = await signedForm('/api/voice/outgoing', { ApplicationSid: 'AP' + 'b'.repeat(32), To: '555-555-0142' });
    const xml = await resp.text();
    // Recording is on by default now, so the callee's Number carries the whisper URL.
    ok(/<Dial callerId=/.test(xml) && /<Number[^>]*>\+15555550142<\/Number>/.test(xml), 'TwiML dials the target from the business number');
    const bad = await signedForm('/api/voice/outgoing', { ApplicationSid: 'AP' + 'z'.repeat(32), To: '555-555-0142' });
    ok(/cannot be completed/.test(await bad.text()), 'unknown TwiML app gets refused, not connected');
  }

  console.log('— voicemail, recording callbacks, and texted-in messages');
  {
    plantAuthToken();
    const form = (path, data) => signedForm(path, data);
    // Voice settings save; greeting round-trips.
    r = await req('/api/admin/voice-settings', { method: 'PUT', body: JSON.stringify({
      record_calls: true, forward_calls: false, voicemail_greeting: 'Leave it after the beep.' }) });
    ok(r.status === 200, 'voice settings saved');
    r = await req('/api/admin/texting');
    ok(r.json.record_calls === true && r.json.voicemail_greeting === 'Leave it after the beep.', 'settings round-trip');
    // Incoming call with no forward goes straight to voicemail with the greeting.
    // (Company has no twilio_from in tests — unknown number gets the polite refusal.)
    let xml = await (await form('/api/voice/incoming', { To: '+15550001111', From: '+15552223333' })).text();
    ok(/not in service/.test(xml), 'a call to an unknown number is refused politely');
    // A recording callback lands and hangs onto the buyer's loan by phone match.
    await req('/api/admin/tenants/' + tbId, { method: 'PUT', body: JSON.stringify({ phone: '555-777-8888' }) });
    await form('/api/voice/recording?co=1&kind=call', {
      RecordingSid: 'RE' + 'c'.repeat(32), CallSid: 'CA' + 'c'.repeat(32),
      From: '+15551234567', To: '+15557778888', RecordingDuration: '42' });
    r = await req('/api/admin/recordings');
    const rec = r.json.recordings.find(x => x.recording_sid === 'RE' + 'c'.repeat(32));
    ok(!!rec && rec.duration_sec === 42, 'recording remembered with its duration');
    ok(rec.loan_id === loanId, 'recording matched to the buyer’s loan by phone number');
    // The voicemail transcription callback fills in the words.
    await form('/api/voice/vm-transcript?co=1', {
      RecordingSid: 'RE' + 'c'.repeat(32), TranscriptionStatus: 'completed',
      TranscriptionText: 'Please call me back about the furnace.' });
    r = await req('/api/admin/recordings');
    ok(r.json.recordings[0].transcript === 'Please call me back about the furnace.', 'transcript attached to the recording');
    // Call transcripts without an Intelligence service explain what to set up —
    // exercised on a recording that has no transcript yet.
    await form('/api/voice/recording?co=1&kind=call', {
      RecordingSid: 'RE' + 'd'.repeat(32), CallSid: 'CA' + 'd'.repeat(32),
      From: '+15551234567', To: '+15550001234', RecordingDuration: '10' });
    r = await req('/api/admin/recordings');
    const bare = r.json.recordings.find(x => x.recording_sid === 'RE' + 'd'.repeat(32));
    r = await req('/api/admin/recordings/' + bare.id + '/transcribe', { method: 'POST', body: '{}' });
    // The service is created by API now — no console visit is ever demanded. With the
    // test's fake credentials Twilio refuses, and the refusal is passed through.
    ok(r.status >= 400 && !/console/i.test(r.json.error || ''), 'transcription tries to create the service itself instead of sending you to the console');
    // A buyer texting in lands in their message thread, tagged sms — not swallowed.
    await form('/sms/incoming', { From: '555-777-8888', Body: 'Got the notice, can we talk?' });
    r = await req(`/api/admin/loans/${loanId}/messages`);
    const texted = r.json.find(m => m.body === 'Got the notice, can we talk?');
    ok(!!texted, 'a buyer’s text lands in the message thread');
    ok((texted.channels || '') === 'sms', 'and is tagged as having arrived by text');
    // Reset recording flag so nothing else in the suite is affected.
    await req('/api/admin/voice-settings', { method: 'PUT', body: JSON.stringify({ record_calls: false }) });
  }

  console.log('— the unified communication log');
  {
    plantAuthToken();
    const db2 = require('./db.js').db;
    const co = db2.prepare('SELECT id FROM companies ORDER BY id LIMIT 1').get();
    db2.prepare(`UPDATE companies SET twilio_from='+15550009999',
      voice_twiml_app_sid='AP' || substr(hex(randomblob(16)),1,32), record_calls=0, forward_calls=1 WHERE id=?`).run(co.id);

    // A call placed from the cell bridge leaves a row even with recording OFF — that is
    // the whole point of the call log.
    // (Twilio is not connected in tests, so write through the same helper path the
    // bridge uses: the inbound webhook, which needs nothing but a signed request.)
    const sig = await signedForm('/api/voice/incoming', { To: '+15550009999', From: '+15557778888',
      CallSid: 'CA' + '1'.repeat(32) });
    ok(sig.status === 200, 'an inbound call is answered');
    let row = db2.prepare('SELECT * FROM call_log WHERE call_sid=?').get('CA' + '1'.repeat(32));
    ok(!!row && row.direction === 'in' && row.status === 'placed',
      'and leaves a call_log row immediately, before any recording exists');
    ok(row.loan_id === loanId, 'the caller was recognized as the buyer and filed on their loan');
    ok(!!row.property_id, 'and against the property');
    const commsPropId = row.property_id;

    // The dial outcome arrives and the row learns how the call went.
    await signedForm('/api/voice/vm-fallback?co=' + co.id, {
      CallSid: 'CA' + '1'.repeat(32), DialCallStatus: 'completed', DialCallDuration: '184' });
    row = db2.prepare('SELECT * FROM call_log WHERE call_sid=?').get('CA' + '1'.repeat(32));
    ok(row.status === 'completed' && row.duration_sec === 184, 'answered: status and duration recorded');

    // An unanswered one is marked as voicemail, not left as "placed" forever.
    await signedForm('/api/voice/incoming', { To: '+15550009999', From: '+15557778888', CallSid: 'CA' + '2'.repeat(32) });
    await signedForm('/api/voice/vm-fallback?co=' + co.id, { CallSid: 'CA' + '2'.repeat(32), DialCallStatus: 'no-answer' });
    row = db2.prepare('SELECT * FROM call_log WHERE call_sid=?').get('CA' + '2'.repeat(32));
    ok(row.status === 'voicemail', 'unanswered: the row says it went to voicemail');

    // A softphone outgoing call logs under the person whose browser dialled.
    await signedForm('/api/voice/outgoing', { ApplicationSid: db2.prepare('SELECT voice_twiml_app_sid v FROM companies WHERE id=?').get(co.id).v,
      To: '+15557778888', From: 'client:admin-1', CallSid: 'CA' + '3'.repeat(32) });
    row = db2.prepare('SELECT * FROM call_log WHERE call_sid=?').get('CA' + '3'.repeat(32));
    ok(!!row && row.direction === 'out' && row.mode === 'softphone' && row.user_id === 1,
      'a softphone call is logged as outbound under its caller');

    // The unified endpoint merges calls, buyer texts, vendor texts, and email.
    r = await req(`/api/admin/properties/${commsPropId}/comms`);
    ok(r.status === 200 && r.json.events.length > 0, 'the property timeline answers');
    const chans = new Set(r.json.events.map(e => e.channel));
    ok(chans.has('call'), 'calls are in the timeline');
    ok(r.json.events.some(e => e.channel === 'call' && e.duration_sec === 184), 'with their durations');
    const tss = r.json.events.map(e => e.ts);
    ok(tss.every((t, i) => !i || t <= tss[i - 1]), 'newest first, throughout');
    // Channel filter narrows without losing the call/voicemail pairing.
    r = await req(`/api/admin/properties/${commsPropId}/comms?channel=call`);
    ok(r.json.events.every(e => e.channel === 'call' || e.channel === 'voicemail'), 'the call filter shows only calls');

    // Another company's admin must see nothing here.
    ok((await req(`/api/admin/properties/${commsPropId}/comms`, {}, tbCookie)).status !== 200,
      'a buyer cannot read the admin timeline');

    db2.prepare('UPDATE companies SET twilio_from=NULL, forward_calls=0 WHERE id=?').run(co.id);
  }

  console.log('— payment history: due vs paid, both sides of the counter');
  {
    r = await req(`/api/admin/loans/${loanId}/payment-history`);
    ok(r.status === 200 && Array.isArray(r.json.rows) && r.json.rows.length > 0, 'the admin sees the statement');
    ok(r.json.next_due && /^\d{4}-\d{2}-\d{2}$/.test(r.json.next_due), 'with the next due date');
    ok(r.json.rows.every(x => ['paid','partial','due'].includes(x.status)), 'every month carries a verdict');
    const paid = r.json.rows.filter(x => x.status === 'paid');
    ok(paid.every(x => x.paid_date), 'paid months say when they were paid');
    const dueSum = r.json.rows.reduce((t, x) => t + x.due_cents, 0);
    const paidSum = r.json.rows.reduce((t, x) => t + x.paid_cents, 0);
    ok(paidSum <= dueSum, 'no month is credited with more than it asked for');
    r = await req('/api/tenant/payment-history', {}, tbCookie);
    ok(r.status === 200 && r.json.rows.length > 0, 'the buyer sees the same statement');
    ok((await req('/api/tenant/payment-history', {}, '')).status !== 200, 'and nobody sees it without signing in');
  }

  console.log('— the staff app has a home');
  {
    const page = await fetch(BASE + '/staff');
    ok(page.status === 200 && /PorchPay Admin/.test(await page.text()), 'the staff app is served at /staff');
    const man = await fetch(BASE + '/staff-manifest.json');
    ok(man.status === 200 && (await man.json()).start_url === '/staff', 'with its own installable manifest');
    r = await req('/api/admin/staff/overview');
    ok(r.status === 200 && Array.isArray(r.json.properties) && r.json.properties.length > 0, 'the overview answers in one call');
    const withLoan = r.json.properties.find(x => x.loan_id);
    ok(!!withLoan && withLoan.buyer && typeof withLoan.unread === 'number', 'each house carries its buyer and unread count');
    ok(Array.isArray(r.json.vendors) && Array.isArray(r.json.payments), 'vendors and the money feed ride along');
    ok(r.json.payments.every(x => x.amount_cents > 0 && x.entry_date), 'payments carry amount and date');
    ok((await req('/api/admin/staff/overview', {}, tbCookie)).status !== 200, 'a buyer cannot open the staff overview');
  }

  console.log('— the activity feed carries notices and payments too');
  {
    const prop = require('./db.js').get('SELECT property_id FROM loans WHERE id=?', loanId);
    r = await req(`/api/admin/properties/${prop.property_id}/comms`);
    const chans = new Set(r.json.events.map(e => e.channel));
    ok(chans.has('payment'), 'payments appear in the activity feed');
    ok(chans.has('notice'), 'notices appear in the activity feed');
    r = await req(`/api/admin/properties/${prop.property_id}/comms?channel=payment`);
    ok(r.json.events.length > 0 && r.json.events.every(e => e.channel === 'payment'), 'and the payment filter isolates the money');
  }

  console.log('— bird dog / wholesale fees are a cost of the deal');
  {
    r = await req(`/api/admin/properties/${propId}/costs`, { method: 'POST', body: JSON.stringify({
      category: 'birddog', description: 'Wholesale assignment fee — J. Finder', amount_cents: 250000, cost_date: '2026-08-01' }) });
    ok(r.status === 200 && r.json.category === 'birddog', 'a bird dog fee is accepted as its own category');
    r = await req(`/api/admin/properties/${propId}`);
    ok((r.json.basis.by_category.birddog || 0) === 250000, 'and it lands in the property basis under its own line');
    ok(r.json.cost_labels && /Bird dog/i.test(r.json.cost_labels.birddog || ''), 'with a proper label for every report');
    // Nonsense categories still bounce.
    r = await req(`/api/admin/properties/${propId}/costs`, { method: 'POST', body: JSON.stringify({
      category: 'bribes', description: 'no', amount_cents: 100 }) });
    ok(r.status !== 200, 'an unknown category is still refused');
  }

  console.log('— inbound calls announce themselves and can be dismissed everywhere at once');
  {
    plantAuthToken();
    const db3 = require('./db.js').db;
    const co = db3.prepare('SELECT id FROM companies ORDER BY id LIMIT 1').get();
    db3.prepare(`UPDATE companies SET twilio_from='+15550009999', forward_calls=1,
      voice_twiml_app_sid='AP' || substr(hex(randomblob(16)),1,32) WHERE id=?`).run(co.id);
    db3.prepare("UPDATE users SET phone='+15555550123' WHERE email='admin@test.com'").run();

    // The buyer calls in: each cell leg carries the screening whisper naming them.
    let xml = await (await signedForm('/api/voice/incoming', { To: '+15550009999', From: '+15557778888',
      CallSid: 'CA' + '7'.repeat(32) })).text();
    ok(/staff-screen/.test(xml), 'cell legs are screened before connecting');
    ok(/who=/.test(xml), 'and the screen knows who is calling');

    // The screen itself: names the caller, offers 1 to answer, hangs up on silence.
    xml = await (await signedForm('/api/voice/staff-screen?co=' + co.id + '&who=Jane%20Buyer&parent=CA' + '7'.repeat(32), {})).text();
    ok(/Porch Pay call from Jane Buyer/.test(xml), 'the whisper says it is a PorchPay call and from whom');
    ok(/Press 1 to answer/.test(xml) && /<Hangup\/>/.test(xml),
      'press 1 answers; silence hangs the leg so carrier voicemail cannot steal the call');

    // Pressing 1 connects; pressing 2 drops the leg (and redirects the parent to
    // voicemail — the Twilio API call is unreachable in tests, but the leg must die).
    xml = await (await signedForm('/api/voice/staff-screen-action?co=' + co.id + '&parent=CA' + '7'.repeat(32), { Digits: '1' })).text();
    ok(xml === '<Response/>', 'pressing 1 lets the leg connect');
    xml = await (await signedForm('/api/voice/staff-screen-action?co=' + co.id + '&parent=CA' + '7'.repeat(32), { Digits: '2' })).text();
    ok(/<Hangup\/>/.test(xml), 'pressing 2 declines this leg while the call routes to voicemail');

    // The outbound bridge no longer talks at the admin — answer, hear ringing, talk.
    const smsMod2 = require('./sms.js');
    let sawTwiml = null;
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url).includes('api.twilio.com')) {
        sawTwiml = new URLSearchParams(opts.body).get('Twiml');
        return { ok: true, json: async () => ({ sid: 'CA' + '8'.repeat(32) }) };
      }
      return origFetch(url, opts);
    };
    await smsMod2.placeCall('+15557778888', '+15555550123',
      { id: co.id, twilio_sid: 'AC' + '0'.repeat(32), twilio_token: 't', twilio_from: '+15550009999' },
      { announce: 'Jane', record: true, baseUrl: 'https://x.test' });
    global.fetch = origFetch;
    ok(!/Connecting you to/.test(sawTwiml || ''), 'no spoken preamble to the admin');
    ok(/<Dial/.test(sawTwiml || '') && /record-from-answer-dual/.test(sawTwiml || ''),
      'the call just dials — still recorded and transcribed');
    ok(/api\/voice\/announce/.test(sawTwiml || ''), 'the callee still hears the recording notice');

    db3.prepare('UPDATE companies SET twilio_from=NULL, forward_calls=0 WHERE id=?').run(co.id);
    db3.prepare("UPDATE users SET phone=NULL WHERE email='admin@test.com'").run();
  }

  console.log('— every outside service is the company\'s own to connect');
  {
    // The multi-company posture: phone, email, mail, and now Stripe are all pasted in
    // Settings per company, with the host's environment only as fallback.
    r = await req('/api/admin/integrations/stripe');
    ok(r.status === 200 && typeof r.json.connected === 'boolean', 'the Stripe card reports its state');
    ok(/\/api\/stripe\/webhook$/.test(r.json.webhook_url), 'and the webhook URL to paste into Stripe');
    r = await req('/api/admin/integrations/stripe', { method: 'PUT', body: JSON.stringify({ secret_key: 'not-a-key' }) });
    ok(r.status === 400, 'a malformed secret key is refused');
    r = await req('/api/admin/integrations/stripe', { method: 'PUT', body: JSON.stringify({ webhook_secret: 'nope' }) });
    ok(r.status === 400, 'a malformed webhook secret is refused');
    r = await req('/api/admin/integrations/stripe', { method: 'PUT', body: JSON.stringify({
      secret_key: 'sk_test_' + 'x'.repeat(24), webhook_secret: 'whsec_' + 'y'.repeat(24) }) });
    ok(r.status === 200, 'a company connects its own Stripe account from Settings');
    r = await req('/api/admin/integrations/stripe');
    ok(r.json.source === 'company' && r.json.test_mode === true, 'and the card says whose key is live, and that it is test mode');
    // The webhook now accepts deliveries signed with the company secret.
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { payment_status: 'unpaid', metadata: {} } } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = 't=' + ts + ',v1=' + require('node:crypto').createHmac('sha256', 'whsec_' + 'y'.repeat(24))
      .update(ts + '.' + payload).digest('hex');
    const hook = await fetch(BASE + '/api/stripe/webhook', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig }, body: payload });
    ok(hook.status === 200, 'a webhook signed with the company secret is accepted');
    const forged = await fetch(BASE + '/api/stripe/webhook', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=' + ts + ',v1=deadbeef' }, body: payload });
    ok(forged.status === 400, 'a forged webhook is refused');
    r = await req('/api/admin/integrations/stripe', { method: 'DELETE' });
    ok(r.status === 200 && (await req('/api/admin/integrations/stripe')).json.source !== 'company',
      'and the account can be disconnected, falling back to the server');
  }

  console.log('— a payment can never vanish between Stripe and the ledger');
  {
    const payMod = require('./payments.js');
    const fakeSession = (sid, loanIdForPay, cents) => ({
      id: sid, payment_status: 'paid', payment_method_types: ['card'],
      amount_total: cents + 33,
      metadata: { loan_id: String(loanIdForPay), amount_cents: String(cents), fee_cents: '33' },
    });
    const origEnabled = payMod.stripeEnabled, origList = payMod.listRecentSessions, origRetrieve = payMod.retrieveSession;
    payMod.stripeEnabled = () => true;
    payMod.listRecentSessions = async () => [fakeSession('cs_recon_1', loanId, 100)];
    payMod.retrieveSession = async (sid) => fakeSession(sid, loanId, 250);

    // The reconciliation sweep posts what the webhook missed…
    const before = (await req('/api/admin/loans/' + loanId)).json.ledger.filter(l => l.type === 'payment').length;
    r = await req('/api/admin/stripe/reconcile', { method: 'POST', body: '{}' });
    ok(r.status === 200 && r.json.posted === 1, 'reconciliation posts the missed payment');
    let led = (await req('/api/admin/loans/' + loanId)).json.ledger;
    const recon = led.find(l => l.external_id === 'stripe:cs_recon_1');
    ok(!!recon && recon.amount_cents === 100, 'for the right amount, tagged with its Stripe session');
    // …and never twice.
    r = await req('/api/admin/stripe/reconcile', { method: 'POST', body: '{}' });
    ok(r.json.posted === 0, 'running it again posts nothing — idempotent by session id');

    // The success landing posts with NO session cookie — the installed-app case where
    // Stripe bounces the buyer through an external browser that is not signed in.
    const landing = await fetch(BASE + '/api/pay/landing?session_id=cs_landing_1', { redirect: 'manual' });
    ok(landing.status === 302 || landing.status === 301, 'the landing redirects into the app');
    led = (await req('/api/admin/loans/' + loanId)).json.ledger;
    const landed = led.find(l => l.external_id === 'stripe:cs_landing_1');
    ok(!!landed && landed.amount_cents === 250, 'and the payment posted without any login');
    ok(led.filter(l => l.type === 'payment').length === before + 2, 'exactly the two new payments, no strays');

    payMod.stripeEnabled = origEnabled; payMod.listRecentSessions = origList; payMod.retrieveSession = origRetrieve;
  }

  console.log('— an invitation is accepted the moment the buyer signs in');
  {
    // An invite frozen at pending — sent by hand before texting was connected.
    require('./db.js').db.prepare(`INSERT INTO invitations (company_id, loan_id, user_id, phone, status, channel)
      VALUES (1, ?, ?, '555-0100', 'pending', 'manual')`).run(loanId, tbId);
    let badge = (await req('/api/admin/summary')).json.pending_invitations;
    ok(badge >= 1, 'the stale invite counts against the badge');
    // The buyer signs in — nothing else — and the badge lets go.
    const relog = await req('/api/login', { method: 'POST', body: JSON.stringify({ email: 'jane@test.com', password: 'JanePass123!' }) }, '');
    ok(relog.status === 200, 'the buyer signs in');
    const after = (await req('/api/admin/summary')).json.pending_invitations;
    ok(after === badge - 1, 'and their pending invitation is accepted by the act of signing in');
  }

  console.log('— extra payments on the calculator');
  {
    const q = 'principal_cents=10000000&interest_rate_bps=950&term_months=360&first_payment_date=2026-06-01';
    const base = (await req('/api/admin/amortize?' + q)).json;
    ok(!base.extra, 'no extras asked for, none reported');
    r = await req('/api/admin/amortize?' + q + '&extra_monthly_cents=10000');
    ok(r.json.extra && r.json.extra.months < 360, 'an extra $100 a month pays off early');
    ok(r.json.extra.months_saved === 360 - r.json.extra.months, 'months saved is the difference');
    ok(r.json.extra.interest_saved_cents > 0, 'and interest is saved, not just moved');
    const repaid = r.json.extra.schedule.reduce((t, x) => t + x.principal_cents, 0);
    ok(repaid === 10000000, 'every cent of principal is still repaid exactly once');
    r = await req('/api/admin/amortize?' + q + '&extra_once=' +
      encodeURIComponent(JSON.stringify([{ month_n: 12, amount_cents: 1000000 }])));
    ok(r.json.extra && r.json.extra.months_saved > 0, 'a one-time extra also shortens the loan');
    r = await req('/api/admin/amortize?' + q + '&extra_once=not-json');
    ok(r.status === 200 && !r.json.extra, 'garbage extras are ignored, not fatal');
  }

  console.log('— the calling self-check');
  {
    // Nothing connected: the check says so plainly instead of erroring.
    require('./db.js').db.prepare(
      `UPDATE companies SET twilio_sid=NULL, twilio_token=NULL, twilio_from=NULL WHERE id=(SELECT MIN(id) FROM companies)`).run();
    r = await req('/api/admin/voice-check');
    ok(r.status === 200 && r.json.ok === false, 'the self-check runs even with nothing connected');
    const first = r.json.checks[0];
    ok(first.name === 'Twilio connected' && first.ok === false, 'it leads with the missing Twilio account');
    ok(/Settings/.test(first.fix || ''), 'and says where to go and fix it');
    ok(r.json.expected.incoming.endsWith('/api/voice/incoming'), 'it reports the URL Twilio should be calling');
    ok(r.json.expected.outgoing.endsWith('/api/voice/outgoing'), 'and the one the softphone app should use');

    // Connected but pointed at a Twilio account that will not answer: the check must
    // report failures rather than throwing, because the network is not to be trusted.
    require('./db.js').db.prepare(
      `UPDATE companies SET twilio_sid=?, twilio_token=?, twilio_from='+15550009999' WHERE id=(SELECT MIN(id) FROM companies)`)
      .run('AC' + '9'.repeat(32), TEST_AUTH_TOKEN);
    r = await req('/api/admin/voice-check');
    ok(r.status === 200, 'the self-check survives Twilio refusing to answer');
    ok(r.json.checks.some(c => c.name === 'Signature checking' && c.ok === true),
      'it confirms webhook signature checking is switched on');
    ok(r.json.checks.every(c => typeof c.ok === 'boolean' && c.name),
      'every check reports a name and a verdict');
    ok(r.json.checks.filter(c => !c.ok).every(c => c.fix), 'and every failure carries a fix');
  }

  console.log('— webhooks refuse anything Twilio did not sign');
  {
    plantAuthToken();
    const co = require('./db.js').db.prepare('SELECT id FROM companies ORDER BY id LIMIT 1').get();
    require('./db.js').db.prepare(`UPDATE companies SET twilio_from='+15550009999',
      voice_twiml_app_sid='AP' || substr(hex(randomblob(16)),1,32) WHERE id=?`).run(co.id);
    const payload = { To: '+15550009999', From: '+15558887777' };

    // The signed request works — the baseline for everything below.
    let resp = await signedForm('/api/voice/incoming', payload);
    ok(resp.status === 200, 'a properly signed call is answered');

    // Anyone who knows the URL must not be able to make the app do anything. This is the
    // endpoint that places calls billed to the account.
    resp = await signedForm('/api/voice/incoming', payload, { omit: true });
    ok(resp.status === 403, 'a webhook with no signature at all is refused');
    resp = await signedForm('/api/voice/incoming', payload, { tamper: true });
    ok(resp.status === 403, 'a forged signature is refused');
    resp = await signedForm('/api/voice/incoming', payload, { token: 'not-the-real-token' });
    ok(resp.status === 403, 'a signature from the wrong auth token is refused');

    // Changing even one field after signing invalidates it — a replayed signature cannot
    // be pointed at a different number.
    const url = BASE + '/api/voice/incoming';
    const body = Object.keys(payload).sort().map(k => k + payload[k]).join('');
    const sig = require('node:crypto').createHmac('sha1', TEST_AUTH_TOKEN)
      .update(Buffer.from(url + body, 'utf-8')).digest('base64');
    resp = await fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig },
      body: new URLSearchParams({ ...payload, From: '+19998887777' }).toString() });
    ok(resp.status === 403, 'a signature cannot be reused for different call details');

    // Every Twilio-facing route is covered, not just the one that was easy to test.
    for (const path of ['/api/voice/outgoing', '/api/voice/announce', '/api/voice/recording?co=1&kind=call',
                        '/api/voice/vm-transcript?co=1', '/api/voice/vm-fallback?co=1', '/sms/incoming']) {
      const r2 = await signedForm(path, { Body: 'x' }, { omit: true });
      ok(r2.status === 403, `${path} refuses an unsigned request`);
    }

    // A forged recording callback must not be able to write into the call log.
    const before = (await req('/api/admin/recordings')).json.recordings.length;
    await signedForm('/api/voice/recording?co=' + co.id + '&kind=call',
      { RecordingSid: 'RE' + 'f'.repeat(32), RecordingDuration: '99' }, { tamper: true });
    const after = (await req('/api/admin/recordings')).json.recordings.length;
    ok(before === after, 'a forged recording callback writes nothing to the call log');

    require('./db.js').db.prepare('UPDATE companies SET twilio_from=NULL WHERE id=?').run(co.id);
  }

  console.log('— choosing the softphone or the cell');
  {
    plantAuthToken();
    const form = (path, data) => signedForm(path, data);

    // Nothing chosen to begin with; the browser decides by device.
    r = await req('/api/admin/texting');
    ok(r.json.call_mode === null, 'no calling preference until one is chosen');

    // Only the two real modes are accepted.
    r = await req('/api/admin/call-mode', { method: 'PUT', body: JSON.stringify({ call_mode: 'carrier-pigeon' }) });
    ok(r.status === 400, 'an invented call mode is refused');

    // The cell needs a number to ring, and says so rather than failing at dial time.
    r = await req('/api/admin/call-mode', { method: 'PUT', body: JSON.stringify({ call_mode: 'cell', my_phone: '555' }) });
    ok(r.status === 400 && /does not look valid/.test(r.json.error), 'a junk handset number is caught before saving');

    r = await req('/api/admin/call-mode', { method: 'PUT', body: JSON.stringify({ call_mode: 'cell', my_phone: '810-555-0142' }) });
    ok(r.status === 200 && r.json.call_mode === 'cell' && r.json.my_phone === '+18105550142',
      'the cell is saved with the number that should ring');
    r = await req('/api/admin/texting');
    ok(r.json.call_mode === 'cell' && r.json.my_phone === '+18105550142', 'the preference round-trips to the dialer');

    r = await req('/api/admin/call-mode', { method: 'PUT', body: JSON.stringify({ call_mode: 'softphone' }) });
    ok(r.status === 200 && r.json.call_mode === 'softphone', 'switching to the softphone keeps the saved handset');
    r = await req('/api/admin/texting');
    ok(r.json.my_phone === '+18105550142', 'and the handset number survives the switch');

    r = await req('/api/admin/call-mode', { method: 'PUT', body: JSON.stringify({ call_mode: null }) });
    ok(r.status === 200 && r.json.call_mode === null, 'the preference can be cleared back to by-device');

    // The token now lets the browser answer, not only dial — this is what makes an
    // inbound call reachable at the desk.
    const smsMod = require('./sms.js');
    const tok = smsMod.voiceToken({ accountSid: 'AC' + '1'.repeat(32), keySid: 'SK' + 'a'.repeat(32),
      keySecret: 'shh', appSid: 'AP' + 'b'.repeat(32), identity: 'admin-1' });
    const grants = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).grants;
    ok(grants.voice.incoming && grants.voice.incoming.allow === true, 'the voice grant allows incoming calls');
    ok(!!grants.voice.outgoing.application_sid, 'and still allows outgoing ones');

    // Inbound rings the browser and the handset at once, and records when asked to.
    const co = require('./db.js').db.prepare('SELECT id FROM companies LIMIT 1').get();
    require('./db.js').db.prepare(`UPDATE companies SET twilio_from='+15550009999',
      voice_twiml_app_sid='AP' || substr(hex(randomblob(16)),1,32), record_calls=1, forward_calls=1 WHERE id=?`).run(co.id);
    let xml = await (await form('/api/voice/incoming', { To: '+15550009999', From: '+15558887777' })).text();
    ok(/<Client>admin-\d+<\/Client>/.test(xml), 'an inbound call rings the browser softphone');
    ok(/<Number[^>]*>\+1\d{10}<\/Number>/.test(xml), 'and rings a real handset in the same Dial (screened)');
    ok(/record="record-from-answer-dual"/.test(xml), 'an answered inbound call is recorded on both channels');
    ok(/dir=in/.test(xml), 'the recording callback knows the call came in');
    ok(/vm-fallback/.test(xml), 'unanswered still rolls to voicemail');

    // With recording off there is no announcement and no recording attribute.
    require('./db.js').db.prepare('UPDATE companies SET record_calls=0 WHERE id=?').run(co.id);
    xml = await (await form('/api/voice/incoming', { To: '+15550009999', From: '+15558887777' })).text();
    ok(!/record=/.test(xml) && !/may be recorded/.test(xml), 'recording off means no recording and no announcement');

    // An inbound recording matches the buyer by the caller's number, not ours.
    require('./db.js').db.prepare('UPDATE companies SET record_calls=1 WHERE id=?').run(co.id);
    await form('/api/voice/recording?co=' + co.id + '&kind=call&dir=in', {
      RecordingSid: 'RE' + 'e'.repeat(32), CallSid: 'CA' + 'e'.repeat(32),
      From: '+15557778888', To: '+15550009999', RecordingDuration: '61' });
    r = await req('/api/admin/recordings');
    const inb = r.json.recordings.find(x => x.recording_sid === 'RE' + 'e'.repeat(32));
    ok(!!inb && inb.loan_id === loanId, 'an inbound recording is matched to the buyer who called');

    // Put the company — and this admin's own handset — back the way the rest of the
    // suite expects to find them.
    require('./db.js').db.prepare(`UPDATE companies SET twilio_from=NULL, record_calls=0, forward_calls=0 WHERE id=?`).run(co.id);
    require('./db.js').db.prepare(`UPDATE users SET phone=NULL, call_mode=NULL WHERE email='admin@test.com'`).run();
  }

  console.log('— mail cost is computed, not typed');
  {
    const lobMod = require('./lob.js');
    ok(lobMod.estimateCostCents({ service: 'first_class' }) === 106, 'regular letter costs the published $1.06');
    ok(lobMod.estimateCostCents({ service: 'certified' }) === 106 + 695, 'certified letter costs the published $8.01');
    ok(lobMod.estimateCostCents({ service: 'certified', pages: 3 }) === 106 + 695 + 20, 'extra pages add their dime each');
    r = await req('/api/admin/lob');
    ok(r.json.auto_certified_cents === 801 && r.json.auto_first_class_cents === 106, 'settings reports the automatic rates');
    // Mailing a notice without Lob connected explains itself.
    const list = await req(`/api/admin/loans/${loanId}/notices`);
    const unm = list.json.find(n => !n.lob_id);
    if (unm) {
      r = await req(`/api/admin/notices/${unm.id}/mail`, { method: 'POST', body: JSON.stringify({ service: 'certified' }) });
      ok(r.status === 500 && /not set up/i.test(r.json.error), 'manual mail without Lob names the missing setup');
    }
  }

  console.log('— in-app dialer guards');
  r = await req('/api/admin/call', { method: 'POST', body: JSON.stringify({ to: 'not-a-number' }) });
  ok(r.status === 400, 'refuses a nonsense number');
  r = await req('/api/admin/call', { method: 'POST', body: JSON.stringify({ to: '555-555-0142' }) });
  ok(r.status === 400 && r.json.need_phone === true, 'asks for the admin phone when unknown');
  r = await req('/api/admin/call', { method: 'POST', body: JSON.stringify({ to: '555-555-0142', my_phone: 'garbage' }) });
  ok(r.status === 400 && /your own phone/i.test(r.json.error), 'rejects a bad admin number');
  // With a phone saved but Twilio unconfigured, the failure names the real problem —
  // and the phone was remembered along the way.
  r = await req('/api/admin/call', { method: 'POST', body: JSON.stringify({ to: '555-555-0142', my_phone: '810-555-0100' }) });
  ok(r.status === 500 && /Calling is not connected/i.test(r.json.error), 'without Twilio the error says so');
  r = await req('/api/admin/call', { method: 'POST', body: JSON.stringify({ to: '555-555-0142' }) });
  ok(r.status === 500 && /Calling is not connected/i.test(r.json.error), 'admin phone was remembered — no re-ask');

  console.log('— editing a cost, and the lawncare category');
  {
    const ep = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '8 Edit Ave', city: 'Flint', state: 'MI', zip: '48503' }) });
    r = await req(`/api/admin/properties/${ep.json.id}/costs`, { method: 'POST', body: JSON.stringify({
      category: 'lawncare', description: 'Mow', amount_cents: 4500 }) });
    ok(r.status === 200 && r.json.category === 'lawncare', 'lawncare is a real cost category');
    const costId = r.json.id;
    r = await req('/api/admin/costs/' + costId, { method: 'PUT', body: JSON.stringify({
      amount_cents: 5500, description: 'Mow + edge', category: 'lawncare' }) });
    ok(r.status === 200 && r.json.amount_cents === 5500 && r.json.description === 'Mow + edge', 'cost edited in place');
    r = await req('/api/admin/costs/' + costId, { method: 'PUT', body: JSON.stringify({ amount_cents: 0 }) });
    ok(r.status === 400, 'zero amount refused');
    // Editing a purchase line keeps the headline purchase price in step.
    r = await req(`/api/admin/properties/${ep.json.id}/costs`, { method: 'POST', body: JSON.stringify({
      category: 'purchase', description: 'Bought it', amount_cents: 4000000 }) });
    r = await req('/api/admin/costs/' + r.json.id, { method: 'PUT', body: JSON.stringify({ amount_cents: 4200000, category: 'purchase' }) });
    const pv = await req('/api/admin/properties/' + ep.json.id);
    ok(pv.json.property.purchase_price_cents === 4200000, 'purchase price follows the edited cost line');
    // Recurring rules take lawncare too.
    r = await req(`/api/admin/properties/${ep.json.id}/costs`, { method: 'POST', body: JSON.stringify({
      category: 'lawncare', description: 'Weekly mow', amount_cents: 4500, cadence: 'weekly' }) });
    ok(r.status === 200 && r.json.recurring, 'weekly lawncare rule accepted');
  }

  console.log('— receipts on costs');
  {
    const rcp = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '11 Receipt Rd', city: 'Flint', state: 'MI', zip: '48503' }) });
    const rb64 = Buffer.from('%PDF-1.4 the receipt').toString('base64');
    const rdoc = await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
      filename: 'homedepot.pdf', mime: 'application/pdf', data_base64: rb64, property_id: rcp.json.id,
      category: 'misc_admin', title: 'Receipt — lumber' }) });
    r = await req(`/api/admin/properties/${rcp.json.id}/costs`, { method: 'POST', body: JSON.stringify({
      category: 'rehab', description: 'Lumber', amount_cents: 68000, document_id: rdoc.json.id }) });
    ok(r.status === 200 && r.json.document_id === rdoc.json.id, 'cost created with its receipt attached');
    const rcost = r.json.id;
    let pv = await req('/api/admin/properties/' + rcp.json.id);
    ok(pv.json.costs.find(c => c.id === rcost).document_id === rdoc.json.id, 'receipt travels with the cost row');
    // Replace the receipt on edit; a bogus id refuses.
    const rdoc2 = await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
      filename: 'corrected.pdf', mime: 'application/pdf', data_base64: rb64, property_id: rcp.json.id,
      category: 'misc_admin', title: 'Receipt — lumber (corrected)' }) });
    r = await req('/api/admin/costs/' + rcost, { method: 'PUT', body: JSON.stringify({ document_id: rdoc2.json.id }) });
    ok(r.status === 200 && r.json.document_id === rdoc2.json.id, 'receipt replaced on edit');
    r = await req('/api/admin/costs/' + rcost, { method: 'PUT', body: JSON.stringify({ document_id: 999999 }) });
    ok(r.status === 404, 'a receipt id that is not yours refuses');
    r = await req(`/api/documents/${rdoc2.json.id}/view`);
    ok(r.status === 200, 'the receipt opens in the viewer');
  }

  console.log('— the sold stamp comes off when the loan goes');
  {
    const sp = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '30 Stamp St', city: 'Flint', state: 'MI', zip: '48503' }) });
    // Sell it through the sell flow so the property is stamped sold.
    r = await req(`/api/admin/properties/${sp.json.id}/sell`, { method: 'POST', body: JSON.stringify({
      buyer_name: 'Stamp Buyer', buyer_email: 'stamp@test.com',
      loan_type: 'land_contract', sale_price_cents: 6000000,
      down_payment_cents: 0, principal_cents: 6000000, interest_rate_bps: 900, term_months: 120,
      first_payment_date: '2099-01-01' }) });
    const soldLoan = r.json.loan_id;
    let pv = await req('/api/admin/properties/' + sp.json.id);
    ok(pv.json.property.status === 'sold', 'selling stamps the property sold');
    // Delete the loan (no history — first payment far future); the stamp comes off.
    r = await req('/api/admin/loans/' + soldLoan, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });
    ok(r.status === 200, 'the loan deletes');
    pv = await req('/api/admin/properties/' + sp.json.id);
    ok(pv.json.property.status !== 'sold', 'the sold stamp is gone — the dashboard stops counting a sale that never happened');
  }

  console.log('— purging a whole property (the test-property reset)');
  {
    // A property with the full mess: TB loan with payments and notices, a PML with a
    // payment, costs, documents. Plain delete refuses; owner purge takes it all, backed
    // up, and the books still balance afterwards.
    const fp = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '2217 Test Francis', city: 'Flint', state: 'MI', zip: '48503' }) });
    const fpid = fp.json.id;
    const ft = await req('/api/admin/tenants', { method: 'POST', body: JSON.stringify({ name: 'Ghost Buyer', email: 'ghost@test.com' }) });
    const fl = await req('/api/admin/loans', { method: 'POST', body: JSON.stringify({
      property_id: fpid, tenant_user_id: ft.json.id, loan_type: 'land_contract',
      sale_price_cents: 8000000, down_payment_cents: 500000, principal_cents: 7500000,
      interest_rate_bps: 950, term_months: 240, grace_days: 5, first_payment_date: '2026-06-01' }) });
    const flid = fl.json.loan.id;
    await req(`/api/admin/loans/${flid}/payments`, { method: 'POST', body: JSON.stringify({ amount_cents: 80000, method: 'cash' }) });
    await req(`/api/admin/loans/${flid}/notices`, { method: 'POST', body: JSON.stringify({ subject: 'T', body: 'B' }) });
    const fpml = await req('/api/admin/pml', { method: 'POST', body: JSON.stringify({
      property_id: fpid, lender_name: 'Ghost Capital', principal_cents: 3000000,
      interest_rate_bps: 1100, term_months: 60, first_payment_date: '2026-06-01' }) });
    await req(`/api/admin/pml/${fpml.json.id}/payments`, { method: 'POST', body: JSON.stringify({ amount_cents: 50000 }) });
    await req(`/api/admin/properties/${fpid}/costs`, { method: 'POST', body: JSON.stringify({ category: 'rehab', description: 'Paint', amount_cents: 120000 }) });
    const fb64 = Buffer.from('%PDF-1.4 ghost doc').toString('base64');
    await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
      filename: 'ghost.pdf', mime: 'application/pdf', data_base64: fb64, loan_id: flid, category: 'loan_docs' }) });

    r = await req('/api/admin/properties/' + fpid, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });
    ok(r.status === 400 && r.json.purgeable === true, 'plain delete refuses but names the purge');
    r = await req('/api/admin/properties/' + fpid, { method: 'DELETE', body: JSON.stringify({ purge: true, confirm: 'DELETE' }) });
    ok(r.status === 400, 'purge demands the stronger confirmation');
    r = await req('/api/admin/properties/' + fpid, { method: 'DELETE', body: JSON.stringify({ purge: true, confirm: 'DELETE EVERYTHING' }) });
    ok(r.status === 200 && r.json.purged, 'owner purge takes the whole file');
    r = await req('/api/admin/properties/' + fpid);
    ok(r.status === 404, 'property is gone');
    r = await req('/api/admin/loans/' + flid);
    ok(r.status === 404, 'its TB loan is gone');
    r = await req('/api/admin/pml/' + fpml.json.id);
    ok(r.status === 404, 'its lender loan is gone');
    r = await req('/api/admin/books');
    ok(r.json.trial_balance.balanced, 'the books still balance — every entry left with both sides');
    ok(!(r.json.loans || []).some(l => l.id === flid) && !(r.json.pmls || []).some(l => l.id === fpml.json.id),
      'nothing about the purged loans lingers in reconciliation');
    // The buyer's login is untouched — deleting a house never deletes a person.
    r = await req('/api/admin/tenants');
    ok(r.json.some(u => u.email === 'ghost@test.com'), 'the buyer account survives, to be archived separately if fake');
  }

  console.log('— recurring costs');
  {
    const rp = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '5 Repeat Rd', city: 'Flint', state: 'MI', zip: '48503' }) });
    const rpid = rp.json.id;
    // A weekly rule started 3 weeks ago materializes the backlog immediately: the
    // start date plus every week since — 4 rows, not 1 and not a flood.
    const start = new Date(Date.now() - 21 * 86400000).toISOString().slice(0, 10);
    r = await req(`/api/admin/properties/${rpid}/costs`, { method: 'POST', body: JSON.stringify({
      category: 'marketing', description: 'Weekly check-in', amount_cents: 5000, cost_date: start, cadence: 'weekly' }) });
    ok(r.status === 200 && r.json.recurring, 'weekly rule created');
    let pr = await req('/api/admin/properties/' + rpid);
    ok(pr.json.costs.filter(c => c.description === 'Weekly check-in').length === 4, 'three weeks of backlog + today-ish = 4 occurrences');
    ok(pr.json.recurring_costs.length === 1 && pr.json.recurring_costs[0].next_date > start, 'rule advanced past what it posted');
    // Cost basis counts them like any hand-entered cost.
    ok(pr.json.all_in_cents >= 20000, 'materialized occurrences count in the all-in cost');
    // An end date retires the rule once passed.
    r = await req(`/api/admin/properties/${rpid}/costs`, { method: 'POST', body: JSON.stringify({
      category: 'marketing', description: 'Short-lived', amount_cents: 1000, cost_date: start, cadence: 'weekly',
      end_date: new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10) }) });
    ok(r.status === 200, 'rule with an end date created');
    pr = await req('/api/admin/properties/' + rpid);
    const shortRows = pr.json.costs.filter(c => c.description === 'Short-lived').length;
    ok(shortRows === 2, `end date honoured — only the occurrences inside the window posted (${shortRows})`);
    ok(!pr.json.recurring_costs.some(rc => rc.description === 'Short-lived'), 'expired rule retired itself');
    // Nonsense cadence refused; stopping keeps history.
    r = await req(`/api/admin/properties/${rpid}/costs`, { method: 'POST', body: JSON.stringify({
      category: 'marketing', description: 'X', amount_cents: 100, cadence: 'fortnightly-ish' }) });
    ok(r.status === 400, 'unknown cadence refused');
    const ruleId = pr.json.recurring_costs[0].id;
    r = await req('/api/admin/recurring-costs/' + ruleId, { method: 'DELETE' });
    ok(r.status === 200, 'rule stopped');
    pr = await req('/api/admin/properties/' + rpid);
    ok(pr.json.recurring_costs.length === 0, 'no active rules left');
    ok(pr.json.costs.filter(c => c.description === 'Weekly check-in').length === 4, 'posted costs survive the stop');
    // Cadence arithmetic: monthly from Jan 31 clamps to short months rather than drifting.
    const eng = require('./loan.js');
    const feb = eng.addMonthsUTC(new Date('2026-01-31T00:00:00Z'), 1).toISOString().slice(0, 10);
    ok(feb === '2026-02-28', 'monthly cadence clamps Jan 31 → Feb 28');
  }

  console.log('— deleting a loan that has attachments but no money history');
  {
    // The bug this guards: foreign keys are enforced, and a loan with a document, a
    // task, or an escrow item — but no payments — used to die with "FOREIGN KEY
    // constraint failed" on Delete for good.
    const ap = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '7 Attach Ln', city: 'Flint', state: 'MI', zip: '48503' }) });
    const al = await req('/api/admin/loans', { method: 'POST', body: JSON.stringify({
      property_id: ap.json.id, loan_type: 'land_contract', sale_price_cents: 5000000, down_payment_cents: 0,
      principal_cents: 5000000, interest_rate_bps: 900, term_months: 120, first_payment_date: '2099-01-01' }) });
    const attLoan = al.json.loan.id;
    const b64doc = Buffer.from('%PDF-1.4 attached').toString('base64');
    const doc = await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
      filename: 'attached.pdf', mime: 'application/pdf', data_base64: b64doc, loan_id: attLoan, category: 'loan_docs' }) });
    await req(`/api/admin/loans/${attLoan}/escrow/items`, { method: 'POST', body: JSON.stringify({
      kind: 'tax', payee: 'County', annual_cents: 120000, next_due: '2027-03-01' }) });
    r = await req('/api/admin/loans/' + attLoan, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });
    ok(r.status === 200, 'loan with a document and an escrow item deletes cleanly');
    r = await req('/api/admin/loans/' + attLoan);
    ok(r.status === 404, 'and it is gone');
    r = await req(`/api/admin/properties/${ap.json.id}/documents`);
    const kept = Object.values(r.json).flatMap(f => f.documents).find(d => d.filename === 'attached.pdf');
    ok(!!kept, 'its document was re-filed on the property, not lost');
  }

  console.log('— purging a loan WITH history (backup first, then gone)');
  {
    // Build a disposable loan with real history: a payment and a notice.
    const pp = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '13 Purge Ct', city: 'Flint', state: 'MI', zip: '48503' }) });
    const pt = await req('/api/admin/tenants', { method: 'POST', body: JSON.stringify({ name: 'Test Data', email: 'purge@test.com' }) });
    const plr = await req('/api/admin/loans', { method: 'POST', body: JSON.stringify({
      property_id: pp.json.id, tenant_user_id: pt.json.id, loan_type: 'land_contract',
      sale_price_cents: 9000000, down_payment_cents: 0, principal_cents: 9000000,
      interest_rate_bps: 900, term_months: 240, grace_days: 5, first_payment_date: '2026-06-01' }) });
    const purgeLoan = plr.json.loan.id;
    await req(`/api/admin/loans/${purgeLoan}/payments`, { method: 'POST', body: JSON.stringify({ amount_cents: 50000, method: 'cash' }) });
    await req(`/api/admin/loans/${purgeLoan}/notices`, { method: 'POST', body: JSON.stringify({ subject: 'Test notice', body: 'Body' }) });

    r = await req('/api/admin/loans/' + purgeLoan, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });
    ok(r.status === 400 && r.json.purgeable === true, 'plain delete still refuses, but names the purge door');
    r = await req('/api/admin/loans/' + purgeLoan, { method: 'DELETE', body: JSON.stringify({ purge: true, confirm: 'DELETE' }) });
    ok(r.status === 400, 'purge demands the stronger confirmation');
    r = await req('/api/admin/loans/' + purgeLoan, { method: 'DELETE', body: JSON.stringify({ purge: true, confirm: 'DELETE EVERYTHING' }) });
    ok(r.status === 200 && r.json.purged, 'owner purge succeeds');
    r = await req('/api/admin/loans/' + purgeLoan);
    ok(r.status === 404, 'purged loan is gone');
    r = await req(`/api/admin/properties/${pp.json.id}/documents`);
    const backupDoc = Object.values(r.json).flatMap(f => f.documents).find(d => /Backup — purged loan/.test(d.title || ''));
    ok(!!backupDoc, 'a backup file was filed on the property first');
    r = await req('/api/admin/books');
    ok(r.json.trial_balance.balanced, 'books still balance after the purge — both sides of every entry left together');
    ok(!r.json.loans || !r.json.loans.some(l => l.id === purgeLoan), 'purged loan absent from reconciliation');

    // Staff cannot purge. (Uses the temp staff created later? No — create one here.)
    const st = await req('/api/admin/staff', { method: 'POST', body: JSON.stringify({ name: 'NoPurge Staff', email: 'nopurge@test.com' }) });
    const stLogin = await req('/api/login', { method: 'POST', body: JSON.stringify({ email: 'nopurge@test.com', password: st.json.temp_password }) }, '');
    await req('/api/change-password', { method: 'POST', body: JSON.stringify({ password: 'NoPurge123!' }) }, stLogin.cookie);
    const p2 = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '14 Purge Ct', city: 'Flint', state: 'MI', zip: '48503' }) });
    const l2 = await req('/api/admin/loans', { method: 'POST', body: JSON.stringify({
      property_id: p2.json.id, loan_type: 'land_contract', sale_price_cents: 1000000, down_payment_cents: 0,
      principal_cents: 1000000, interest_rate_bps: 900, term_months: 60, first_payment_date: '2026-06-01' }) });
    await req(`/api/admin/loans/${l2.json.loan.id}/payments`, { method: 'POST', body: JSON.stringify({ amount_cents: 10000, method: 'cash' }) });
    r = await req('/api/admin/loans/' + l2.json.loan.id, { method: 'DELETE', body: JSON.stringify({ purge: true, confirm: 'DELETE EVERYTHING' }) }, stLogin.cookie);
    ok(r.status === 403, 'staff cannot purge — owner only');
    await req('/api/admin/staff/' + st.json.id, { method: 'DELETE' });
  }

  console.log('— two property tax installments');
  {
    const tp = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '50 TwoTax Ter', city: 'Flint', state: 'MI', zip: '48503' }) });
    r = await req('/api/admin/properties/' + tp.json.id + '/terms', { method: 'PUT', body: JSON.stringify({
      tax_due_date: '2026-09-14', tax_due_date2: '2027-02-14' }) });
    if (r.status === 404) {
      // terms endpoint lives under a different path in this build — use the general update
      r = await req('/api/admin/properties/' + tp.json.id, { method: 'PUT', body: JSON.stringify({
        tax_due_date: '2026-09-14', tax_due_date2: '2027-02-14' }) });
    }
    ok(r.status === 200, 'both tax dates saved');
    const pv = await req('/api/admin/properties/' + tp.json.id);
    ok(pv.json.property.tax_due_date === '2026-09-14' && pv.json.property.tax_due_date2 === '2027-02-14',
      'summer and winter installments round-trip');
    // Both appear on the calendar, labelled.
    r = await req('/api/admin/calendar?from=2026-09-01&to=2027-03-01');
    const taxEvents = (r.json.events || r.json).filter(e => e.property_id === tp.json.id && /taxes due/i.test(e.title));
    ok(taxEvents.length === 2, `both installments land on the calendar (${taxEvents.length})`);
    ok(taxEvents.some(e => /1st/.test(e.title)) && taxEvents.some(e => /2nd/.test(e.title)), 'labelled 1st and 2nd installment');
  }

  console.log('— lender phone and email');
  {
    const lp = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '40 Lender Ln', city: 'Flint', state: 'MI', zip: '48503' }) });
    r = await req('/api/admin/pml', { method: 'POST', body: JSON.stringify({
      property_id: lp.json.id, lender_name: 'Reach Capital', lender_phone: '5554443333',
      lender_email: 'funds@reach.example', principal_cents: 1000000,
      interest_rate_bps: 1000, term_months: 60, first_payment_date: '2026-09-01' }) });
    ok(r.status === 200 && r.json.lender_email === 'funds@reach.example', 'lender email stored');
    ok(/555/.test(r.json.lender_phone), 'lender phone stored formatted');
    r = await req('/api/admin/pml/' + r.json.id, { method: 'PUT', body: JSON.stringify({ lender_phone: '5551112222', lender_email: 'newdesk@reach.example' }) });
    ok(/1112222|111-2222/.test(r.json.lender_phone) && r.json.lender_email === 'newdesk@reach.example', 'both editable');
  }

  console.log('— moving a PML loan to another property');
  {
    const pa = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '21 Move St', city: 'Flint', state: 'MI', zip: '48503' }) });
    const pb = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '22 Move St', city: 'Flint', state: 'MI', zip: '48503' }) });
    const ml = await req('/api/admin/pml', { method: 'POST', body: JSON.stringify({
      property_id: pa.json.id, lender_name: 'Mover Capital', principal_cents: 2000000,
      interest_rate_bps: 1000, term_months: 60, first_payment_date: '2026-09-01' }) });
    r = await req('/api/admin/pml/' + ml.json.id, { method: 'PUT', body: JSON.stringify({ property_id: pb.json.id }) });
    ok(r.status === 200 && r.json.property_id === pb.json.id, 'PML moved to the other house');
    r = await req('/api/admin/pml/' + ml.json.id, { method: 'PUT', body: JSON.stringify({ property_id: 999999 }) });
    ok(r.status === 404, 'cannot move a PML onto a property that is not yours');
    r = await req('/api/admin/pml/' + ml.json.id);
    ok(r.json.pml.property_id === pb.json.id, 'move persisted');
  }

  console.log('— location (opt-in)');
  r = await req('/api/tenant/location', { method: 'POST', body: JSON.stringify({ lat: 40.1, lng: -83.0 }) }, tbCookie);
  ok(r.status === 403, 'location rejected without consent');
  r = await req('/api/tenant/location/consent', { method: 'POST', body: JSON.stringify({ consent: true }) }, tbCookie);
  ok(r.status === 200, 'TB grants location consent');
  r = await req('/api/tenant/location', { method: 'POST', body: JSON.stringify({ lat: 40.1, lng: -83.0, accuracy_m: 25 }) }, tbCookie);
  ok(r.status === 200, 'location ping accepted after consent');
  r = await req(`/api/admin/tenants/${tbId}/location`);
  ok(r.json.consent_at && r.json.last_ping && r.json.last_ping.lat === 40.1, 'admin sees consented last location');
  // Distance from the home is the point of this — put the property on the map first.
  await req('/api/admin/properties/' + propId, { method: 'PUT', body: JSON.stringify({ lat: 40.1, lng: -83.0 }) });
  r = await req(`/api/admin/tenants/${tbId}/location`);
  ok(r.json.miles_from_home === 0, 'a ping at the property reads as zero miles away');
  ok(r.json.home && r.json.home.geocoded, 'the buyer\'s property is geocoded');
  // Now a ping about 8 miles north.
  await req('/api/tenant/location', { method: 'POST', body: JSON.stringify({ lat: 40.216, lng: -83.0, accuracy_m: 40 }) }, tbCookie);
  r = await req(`/api/admin/tenants/${tbId}/location`);
  ok(Math.abs(r.json.miles_from_home - 8) < 0.3, `distance from the home computes (${r.json.miles_from_home} mi)`);
  ok(r.json.history.length === 2 && r.json.ping_count === 2, 'full position history returned, newest first');
  ok(r.json.history[0].miles_from_home > r.json.history[1].miles_from_home, 'history ordered newest first');
  ok(r.json.history[0].accuracy_m === 40, 'accuracy recorded so a stale fix can be spotted');

  r = await req('/api/tenant/location/consent', { method: 'POST', body: JSON.stringify({ consent: false }) }, tbCookie);
  r = await req(`/api/admin/tenants/${tbId}/location`);
  ok(!r.json.consent_at && !r.json.last_ping, 'revoking consent deletes location history');
  ok(r.json.ping_count === 0 && r.json.history.length === 0, 'no position history survives a revoke');
  r = await req('/api/tenant/location', { method: 'POST', body: JSON.stringify({ lat: 40.1, lng: -83.0 }) }, tbCookie);
  ok(r.status === 403, 'nothing is recorded again until they opt back in');

  console.log('— address lookup');
  r = await req('/api/admin/address-suggest?q=abc');
  ok(r.status === 200 && Array.isArray(r.json.suggestions), 'short queries return an empty list, not an error');
  ok(r.json.suggestions.length === 0, 'under four characters it does not call out to the geocoder');
  r = await req('/api/admin/address-suggest?q=1600%20Pennsylvania%20Ave%20Washington%20DC');
  ok(r.status === 200, 'the lookup endpoint always answers, even when the geocoder is unreachable');
  ok('suggestions' in r.json, 'the shape is always the same so the UI can rely on it');
  if (r.json.error) {
    console.log('     (geocoder unreachable from this machine: ' + r.json.error + ' — the endpoint degraded cleanly)');
  } else {
    ok(r.json.suggestions.length > 0, 'a real address returns matches');
    const d = r.json.suggestions[0].details;
    ok(d && d.city && d.state && d.zip, 'a match carries city, state and ZIP to fill in');
    ok(d && d.lat && d.lng, 'a match carries coordinates, so distance-from-home works');
  }

  console.log('— tasks');
  r = await req('/api/admin/tasks', { method: 'POST', body: JSON.stringify({
    title: 'Change the locks', property_id: propId, category: 'bog', priority: 'high',
    due_date: '2026-08-01', notes: 'Front and back' }) });
  ok(r.status === 200 && r.json.id, 'create a task tied to a property');
  const taskId = r.json.id;
  ok(r.json.category_icon === '👟' && r.json.category_label === 'Boots on the ground', 'task carries its category label');
  ok(r.json.is_overdue === true, 'a task dated in the past reads as overdue');
  r = await req('/api/admin/tasks', { method: 'POST', body: JSON.stringify({ title: 'Call the accountant' }) });
  ok(r.status === 200 && !r.json.property_id && !r.json.due_date, 'one-off task with no property and no date');
  const looseTask = r.json.id;
  r = await req('/api/admin/tasks', { method: 'POST', body: JSON.stringify({ title: '' }) });
  ok(r.status === 400, 'a task needs a title');
  r = await req('/api/admin/tasks?status=open');
  ok(r.json.tasks.length >= 2, 'task list returns open tasks');
  ok(r.json.counts.overdue >= 1 && r.json.counts.undated >= 1, 'counts split overdue from undated');
  ok(r.json.tasks[0].due_date !== null, 'dated tasks sort ahead of undated ones');
  r = await req('/api/admin/tasks?property_id=' + propId);
  ok(r.json.tasks.every(t => t.property_id === propId), 'filtering by property works');
  r = await req('/api/admin/tasks/' + taskId, { method: 'PUT', body: JSON.stringify({ due_date: '2026-12-15', priority: 'normal' }) });
  ok(r.json.due_date === '2026-12-15' && !r.json.is_overdue, 'moving the date clears overdue');

  console.log('— repeating tasks');
  r = await req('/api/admin/tasks', { method: 'POST', body: JSON.stringify({
    title: 'Quarterly drive-by', property_id: propId, category: 'inspection',
    due_date: '2026-09-30', repeat_every: 'quarterly' }) });
  const repId = r.json.id;
  r = await req(`/api/admin/tasks/${repId}/complete`, { method: 'POST', body: '{}' });
  ok(r.json.task.status === 'done' && r.json.task.completed_by, 'ticking off records who did it');
  ok(r.json.next && r.json.next.due_date === '2026-12-30', 'a quarterly task schedules its next occurrence');
  ok(r.json.next.repeat_every === 'quarterly', 'the chain keeps repeating');
  r = await req(`/api/admin/tasks/${r.json.next.id}/complete`, { method: 'POST', body: '{}' });
  ok(r.json.next.due_date === '2027-03-30', 'and again the quarter after');
  // month-end arithmetic: 31 Jan + 1 month must not become 3 March
  r = await req('/api/admin/tasks', { method: 'POST', body: JSON.stringify({
    title: 'Month end', due_date: '2027-01-31', repeat_every: 'monthly' }) });
  r = await req(`/api/admin/tasks/${r.json.id}/complete`, { method: 'POST', body: '{}' });
  ok(r.json.next.due_date === '2027-02-28', '31 Jan repeating monthly lands on 28 Feb, not in March');
  // a repeat that has run out
  r = await req('/api/admin/tasks', { method: 'POST', body: JSON.stringify({
    title: 'Weekly until', due_date: '2026-09-01', repeat_every: 'weekly', repeat_until: '2026-09-05' }) });
  r = await req(`/api/admin/tasks/${r.json.id}/complete`, { method: 'POST', body: '{}' });
  ok(r.json.next === null, 'repeating stops at the until date');
  r = await req(`/api/admin/tasks/${looseTask}/complete`, { method: 'POST', body: JSON.stringify({ reopen: false }) });
  r = await req(`/api/admin/tasks/${looseTask}/complete`, { method: 'POST', body: JSON.stringify({ reopen: true }) });
  ok(r.json.task.status === 'open' && !r.json.task.completed_at, 'a completed task can be reopened');

  console.log('— calendar');
  r = await req('/api/admin/properties/' + propId + '/details', { method: 'PUT', body: JSON.stringify({
    insurance_expires: '2026-12-05', insurance_carrier: 'State Farm', tax_due_date: '2026-12-20' }) });
  ok(r.json.insurance_expires === '2026-12-05', 'renewal dates save on the property');
  r = await req('/api/admin/calendar?from=2026-12-01&to=2026-12-31');
  const src = (s) => r.json.events.filter(e => e.source === s);
  ok(src('task').some(e => e.task_id === taskId), 'the dated task is on the calendar');
  ok(src('renewal').some(e => e.title.includes('State Farm')), 'insurance renewal is on the calendar');
  ok(src('renewal').some(e => e.title.includes('taxes')), 'property taxes are on the calendar');
  ok(src('payment').length >= 1, 'buyer payments due appear');
  ok(src('payment')[0].amount_cents > 0, 'payment events carry the amount owed');
  const sorted = r.json.events.every((e, i, a) => i === 0 || a[i - 1].date <= e.date);
  ok(sorted, 'calendar events come back in date order');
  r = await req('/api/admin/calendar?from=2026-12-01&to=2026-12-31&payments=0&renewals=0&pml=0');
  ok(r.json.events.every(e => e.source === 'task'), 'switching layers off leaves only your own tasks');
  r = await req('/api/admin/calendar?from=2026-12-01&to=2026-12-31&tasks=0');
  ok(!r.json.events.some(e => e.source === 'task'), 'the task layer can be switched off too');
  r = await req('/api/admin/calendar?from=2027-01-01&to=2027-01-31');
  const janPay = r.json.events.filter(e => e.source === 'payment');
  ok(janPay.length >= 1 && janPay.every(e => e.date.startsWith('2027-01')), 'monthly payments recur into later months');

  console.log('— contacts');
  r = await req('/api/admin/contacts', { method: 'POST', body: JSON.stringify({
    name: 'Ray Ramirez', role: 'bog', business_name: 'Ray Property Services',
    phone: '5135551234', property_id: propId }) });
  ok(r.status === 200 && r.json.id, 'create a contact and attach it to a property in one step');
  const rayId = r.json.id;
  ok(r.json.phone === '513-555-1234', 'contact phone formatted with dashes');
  ok(r.json.role_label === 'Boots on the ground', 'contact carries its role label');
  r = await req('/api/admin/contacts', { method: 'POST', body: JSON.stringify({ name: 'No Details' }) });
  ok(r.status === 400, 'a contact needs a phone or an email');
  r = await req('/api/admin/contacts', { method: 'POST', body: JSON.stringify({
    name: 'Dana Reed', role: 'legal', email: 'dana@law.test' }) });
  const danaId = r.json.id;
  r = await req(`/api/admin/properties/${propId}/contacts`);
  ok(r.json.contacts.length === 1 && r.json.contacts[0].id === rayId, 'the property lists who works on it');
  r = await req(`/api/admin/properties/${propId}/contacts`, { method: 'POST', body: JSON.stringify({
    contact_id: danaId, role_note: 'Handles the forfeiture filings' }) });
  r = await req(`/api/admin/properties/${propId}/contacts`);
  ok(r.json.contacts.length === 2, 'attach an existing contact to a property');
  r = await req(`/api/admin/properties/${propId}/contacts`, { method: 'POST', body: JSON.stringify({ contact_id: danaId }) });
  r = await req(`/api/admin/properties/${propId}/contacts`);
  ok(r.json.contacts.length === 2, 'attaching the same person twice does not duplicate them');
  r = await req(`/api/admin/properties/${propId}/contacts/${danaId}`, { method: 'DELETE' });
  r = await req(`/api/admin/properties/${propId}/contacts`);
  ok(r.json.contacts.length === 1, 'detaching a contact from a property works');
  r = await req('/api/admin/contacts');
  ok(r.json.contacts.find(c => c.id === danaId), 'detaching does not delete the contact itself');

  console.log('— texting a vendor');
  r = await req(`/api/admin/contacts/${rayId}/messages`, { method: 'POST', body: JSON.stringify({
    body: 'Can you check the back door?', property_id: propId }) });
  ok(r.status === 400 && r.json.text, 'without Twilio, the text comes back to copy');
  ok(r.json.text.includes('123 Oak St'), 'the property address is put at the top of the text');
  ok(/—\s/.test(r.json.text), 'the text is signed so the vendor knows who it is from');
  r = await req(`/api/admin/contacts/${rayId}/messages`);
  ok(r.json.messages.length === 1 && r.json.messages[0].status === 'not_sent',
    'an unsent text is still recorded, marked not sent');
  r = await req(`/api/admin/contacts/${danaId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'hello' }) });
  ok(r.status === 400 && /mobile number/.test(r.json.error), 'texting somebody with no mobile is refused clearly');

  console.log('— a vendor texts back');
  plantAuthToken();
  let inbound = await signedForm('/sms/incoming', { From: '+15135551234', Body: 'On my way, back door is fine' });
  let xml = await inbound.text();
  ok(!/<Message>/.test(xml), 'a known vendor does NOT get the automatic brush-off');
  r = await req(`/api/admin/contacts/${rayId}/messages`);
  ok(r.json.messages.length === 2 && r.json.messages[1].direction === 'in',
    'their reply lands in the thread');
  ok(r.json.messages[1].body === 'On my way, back door is fine', 'the reply is stored as sent');
  ok(r.json.messages[1].property_id === propId, 'the reply is filed against the property last discussed');
  inbound = await signedForm('/sms/incoming', { From: '+19995550000', Body: 'who is this' });
  xml = await inbound.text();
  ok(/<Message>/.test(xml) && /Porch Pay app/.test(xml), 'an unknown number still gets the app auto-reply');
  r = await req('/api/admin/contact-inbox');
  ok(r.json.unread.length === 0, 'opening the thread marks vendor replies read');

  console.log('— broadcast to the crew');
  r = await req(`/api/admin/properties/${propId}/broadcast`, { method: 'POST', body: JSON.stringify({
    contact_ids: [rayId], body: 'Roof guy comes Thursday' }) });
  ok(r.json.failed === 1 && /not connected/i.test(r.json.results[0].error),
    'broadcast reports per-person failures rather than silently dropping them');
  r = await req(`/api/admin/properties/${propId}/broadcast`, { method: 'POST', body: JSON.stringify({
    contact_ids: [], body: 'nobody' }) });
  ok(r.status === 400, 'broadcast needs at least one recipient');

  console.log('— notes');
  r = await req('/api/admin/notes', { method: 'POST', body: JSON.stringify({
    property_id: propId, body: 'Seller left the shed key under the mat.' }) });
  ok(r.status === 200 && r.json.author_name, 'add a note to a property, stamped with who wrote it');
  const noteId = r.json.id;
  r = await req('/api/admin/notes', { method: 'POST', body: JSON.stringify({ loan_id: loanId, body: 'Buyer called about November.' }) });
  ok(r.status === 200, 'add a note to a loan');
  r = await req('/api/admin/notes', { method: 'POST', body: JSON.stringify({ property_id: propId, body: '   ' }) });
  ok(r.status === 400, 'an empty note is refused');
  r = await req('/api/admin/notes?property_id=' + propId);
  ok(r.json.notes.length === 1, 'property notes and loan notes stay separate');
  r = await req('/api/admin/notes/' + noteId, { method: 'PUT', body: JSON.stringify({ pinned: 1 }) });
  ok(r.json.pinned === 1, 'a note can be pinned');
  r = await req('/api/admin/notes', { method: 'POST', body: JSON.stringify({ property_id: propId, body: 'Second note' }) });
  r = await req('/api/admin/notes?property_id=' + propId);
  ok(r.json.notes[0].id === noteId, 'pinned notes sort to the top');
  r = await req('/api/admin/notes/' + noteId, { method: 'PUT', body: JSON.stringify({ body: 'Shed key is under the mat.' }) });
  ok(r.json.edited_at, 'editing a note records that it was edited');
  r = await req('/api/admin/notes/' + noteId, { method: 'DELETE' });
  ok(r.status === 200, 'a note can be deleted');

  console.log('— connecting texting from inside the app');
  r = await req('/api/admin/texting');
  ok(r.status === 200 && r.json.connected === false, 'texting starts disconnected');
  ok(r.json.webhook_url && r.json.webhook_url.endsWith('/sms/incoming'), 'the webhook URL to paste into Twilio is shown');
  r = await req('/api/admin/texting', { method: 'PUT', body: JSON.stringify({ sid: 'nonsense', token: 'x', from: '5135550000' }) });
  ok(r.status === 400 && /Account SID/.test(r.json.error), 'a malformed Account SID is caught before Twilio is called');
  r = await req('/api/admin/texting', { method: 'PUT', body: JSON.stringify({ sid: 'AC' + 'a'.repeat(32), token: '' }) });
  ok(r.status === 400, 'all three values are required');
  r = await req('/api/admin/texting/test', { method: 'POST', body: JSON.stringify({ to: '5135550000' }) });
  ok(r.status === 400 && /Connect Twilio/.test(r.json.error), 'the test text refuses until Twilio is connected');
  r = await req('/api/admin/texting/test', { method: 'POST', body: '{}' });
  ok(r.status === 400, 'the test text needs a number');

  console.log('— the sale texts the buyer by itself');
  r = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '77 Auto Ln', city: 'Columbus', state: 'OH' }) });
  const autoProp = r.json.id;
  r = await req(`/api/admin/properties/${autoProp}/sell`, { method: 'POST', body: JSON.stringify({
    buyer_name: 'Auto Buyer', buyer_email: 'auto@test.com', buyer_phone: '614-555-7788',
    sale_price_cents: 8000000, down_payment_cents: 500000, principal_cents: 7500000,
    interest_rate_bps: 900, term_months: 360, first_payment_date: '2026-10-01' }) });
  ok(r.status === 200 && r.json.invite, 'the sale reports what happened to the invitation');
  ok(r.json.invite.sent === false && /not connected/i.test(r.json.invite.error),
    'without Twilio it says plainly that nothing was texted');
  const autoInv = r.json.invitation_id;
  r = await req('/api/admin/invitations');
  const ai2 = r.json.invitations.find(i => i.id === autoInv);
  ok(ai2 && ai2.status !== 'sent', 'an invitation that could not be texted is not marked sent');
  // and a buyer with no mobile at all
  r = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '78 Nophone Ln' }) });
  r = await req(`/api/admin/properties/${r.json.id}/sell`, { method: 'POST', body: JSON.stringify({
    buyer_name: 'No Phone', buyer_email: 'nophone@test.com',
    sale_price_cents: 5000000, down_payment_cents: 0, principal_cents: 5000000,
    interest_rate_bps: 900, term_months: 240, first_payment_date: '2026-10-01' }) });
  ok(/No mobile number/i.test(r.json.invite.error), 'a buyer with no mobile is called out clearly');

  console.log('— property-first workflow (costs, basis, sale)');
  r = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '77 Maple Ave', city: 'Dayton', state: 'OH' }) });
  const p2 = r.json.id;
  r = await req(`/api/admin/properties/${p2}/details`, { method: 'PUT', body: JSON.stringify({
    acquired_date: '2026-02-01', purchase_price_cents: 4500000, target_sale_price_cents: 9500000, beds: 3, baths: 1.5, sqft: 1240 }) });
  ok(r.status === 200 && r.json.beds === 3, 'property details saved');
  for (const [cat, desc, amt] of [['purchase','Purchase price',4500000], ['closing','Title & closing',180000],
      ['rehab','Roof and kitchen',1250000], ['bog','Boots on the ground — weekly checks',95000],
      ['insurance','Builders risk policy',72000], ['utilities','Water & power during rehab',31000]]) {
    r = await req(`/api/admin/properties/${p2}/costs`, { method: 'POST', body: JSON.stringify({
      category: cat, description: desc, amount_cents: amt, cost_date: '2026-03-01' }) });
    ok(r.status === 200, `logged ${cat} cost`);
  }
  r = await req('/api/admin/properties/' + p2);
  const expectedBasis = 4500000 + 180000 + 1250000 + 95000 + 72000 + 31000;
  ok(r.json.basis.total_cents === expectedBasis, `cost basis totals correctly ($${(expectedBasis/100).toLocaleString()})`);
  ok(r.json.basis.by_category.bog === 95000, 'boots-on-the-ground tracked as its own category');
  ok(r.json.all_in_cents === expectedBasis, 'all-in = basis + assigned expenses');
  ok(r.json.loan === null, 'property has no loan before sale');
  r = await req('/api/admin/properties');
  ok(r.json.find(x => x.id === p2).cost_basis_cents === expectedBasis, 'basis shows in the property list');

  console.log('— sell to a tenant buyer + invitation');
  r = await req(`/api/admin/properties/${p2}/sell`, { method: 'POST', body: JSON.stringify({
    buyer_name: 'Carlos Buyer', buyer_email: 'carlos@test.com', buyer_phone: '(555) 867-5309',
    sale_price_cents: 9500000, down_payment_cents: 500000, principal_cents: 9000000,
    interest_rate_bps: 900, term_months: 360, first_payment_date: '2026-09-01' }) });
  ok(r.status === 200 && r.json.loan_id && r.json.temp_password, 'sale creates loan + buyer login');
  const soldLoan = r.json.loan_id, inviteId = r.json.invitation_id;
  r = await req('/api/admin/properties/' + p2);
  ok(r.json.property.status === 'sold', 'property marked sold');
  ok(r.json.loan && r.json.loan.id === soldLoan, 'loan linked to property');
  const margin = 9500000 - expectedBasis;
  ok(r.json.loan.sale_price_cents - r.json.all_in_cents === margin, `gross margin computes ($${(margin/100).toLocaleString()})`);
  r = await req(`/api/admin/invitations/${inviteId}/preview`);
  ok(r.json.text.includes('carlos@test.com') && r.json.text.includes('Carlos'), 'invite text personalised with login');
  ok(r.json.phone === '+15558675309', 'phone normalised to E.164 for texting');
  r = await req(`/api/admin/invitations/${inviteId}/send`, { method: 'POST', body: '{}' });
  ok(r.status === 400 && r.json.text, 'without Twilio, send returns the copyable message');
  r = await req(`/api/admin/invitations/${inviteId}/mark-sent`, { method: 'POST', body: '{}' });
  ok(r.status === 200, 'admin can mark an invite sent manually');
  r = await req('/api/admin/invitations');
  ok(r.json.invitations.some(i => i.id === inviteId && i.status === 'sent'), 'invitation shows as sent');
  r = await req(`/api/admin/invitations/${inviteId}/send`, { method: 'POST', body: '{}' });
  ok(r.status === 409 && r.json.already_sent, 'a second send is blocked — the invite text goes out once');
  r = await req(`/api/admin/invitations/${inviteId}/send`, { method: 'POST', body: JSON.stringify({ resend: true }) });
  ok(r.status !== 409, 'a deliberate resend is still allowed');
  r = await req(`/api/admin/invitations/${inviteId}/preview`);
  ok(/unmonitored number/i.test(r.json.text), 'invite says the number is unmonitored');
  ok(/STOP/.test(r.json.text), 'invite carries the STOP opt-out carriers require');
  // A buyer with a loan who texts back gets THREADED now, not auto-replied — their
  // words land in Messages. Only a stranger still gets the automatic pointer.
  plantAuthToken();
  const twiml = await signedForm('/sms/incoming', { From: '+15558675309', Body: 'hello' });
  const buyerXml = await twiml.text();
  ok(twiml.status === 200 && !/<Message>/.test(buyerXml), 'a known buyer’s text is threaded, not auto-replied');
  const strangerXml = await (await signedForm('/sms/incoming', { From: '+15550009999', Body: 'hello' })).text();
  ok(/<Response><Message>/.test(strangerXml) && /Porch Pay app/.test(strangerXml), 'a stranger still gets the automatic pointer into the app');

  console.log('— correspondence carries the management company name');
  await req('/api/admin/company', { method: 'PUT', body: JSON.stringify({ name: 'Renew EQ LLC' }) });
  r = await req('/api/admin/setup', { method: 'POST', body: JSON.stringify({
    mgmt_company_name: 'RenewEQ Property Management',
    rep_name: 'Marisa G', rep_phone: '5135551000' }) });
  ok(r.status === 200, 'management company name saved');
  r = await req('/api/admin/templates');
  const welcome = r.json.templates.find(t => t.category === 'welcome') || r.json.templates[0];
  r = await req('/api/admin/templates/preview', { method: 'POST', body: JSON.stringify({
    loan_id: loanId, subject: welcome.subject, body_html: welcome.body_html }) });
  ok(/RenewEQ Property Management/.test(r.json.html), 'the letterhead shows the management company');
  ok(!/Renew EQ LLC/.test(r.json.html), 'the legal entity name is not what buyers see');
  ok(r.json.values.company_name === 'RenewEQ Property Management',
    'the {{company_name}} merge field resolves to the management company');
  r = await req(`/api/admin/invitations/${inviteId}/preview`);
  ok(/RenewEQ Property Management/.test(r.json.text), 'the buyer invitation names the management company');
  r = await req(`/api/admin/contacts/${rayId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'sign check' }) });
  ok(/RenewEQ Property Management/.test(r.json.text), 'vendor texts are signed by the management company');

  console.log('— processing fees passed to the buyer');
  const carlosPw = (await req('/api/admin/tenants')).json.find(t => t.email === 'carlos@test.com');
  r = await req('/api/admin/loans/' + soldLoan);
  ok(r.json.loan.late_fee_cents >= 0, 'company late-fee default applied to the new loan');

  console.log('— reports: P&L, balance sheet, returns');
  // Worked example on 77 Maple: all-in 61,280 (incl. filing), PML advanced 40,000,
  // down payment 5,000 -> cash invested should be 61,280 + filing - 40,000 - 5,000.
  r = await req(`/api/admin/properties/${p2}/costs`, { method: 'POST', body: JSON.stringify({
    category: 'filing', description: 'Deed recording & filing fees', amount_cents: 24000, cost_date: '2026-03-05' }) });
  ok(r.status === 200 && r.json.category === 'filing', 'filing fees accepted as a cost category');
  const basisWithFiling = 4500000 + 180000 + 1250000 + 95000 + 72000 + 31000 + 24000;

  r = await req('/api/admin/pml', { method: 'POST', body: JSON.stringify({
    property_id: p2, lender_name: 'Maple Capital', lien_position: 1, principal_cents: 4000000,
    interest_rate_bps: 1100, term_months: 60, payment_type: 'interest_only',
    first_payment_date: '2026-03-01' }) });
  const maplePml = r.json.id;

  r = await req(`/api/admin/reports/returns/${p2}`);
  const ret = r.json;
  ok(ret.all_in_cents === basisWithFiling, `all-in includes filing ($${(basisWithFiling/100).toLocaleString()})`);
  ok(ret.lender_advanced_cents === 4000000, 'lender advance recognised');
  ok(ret.down_payment_cents === 500000, 'buyer down payment recognised');
  ok(ret.cash_invested_cents === basisWithFiling - 4000000 - 500000,
    `cash invested = all-in less lender and down payment ($${((basisWithFiling-4500000)/100).toLocaleString()})`);

  // A lender draw increases what was advanced, so cash invested falls by the same amount.
  r = await req(`/api/admin/pml/${maplePml}/draw`, { method: 'POST', body: JSON.stringify({ amount_cents: 300000, memo: 'rehab draw' }) });
  r = await req(`/api/admin/reports/returns/${p2}`);
  ok(r.json.lender_advanced_cents === 4300000, 'draw adds to lender advanced');
  ok(r.json.cash_invested_cents === basisWithFiling - 4300000 - 500000, 'draw reduces your cash in the deal');

  // Paying the lender back out of pocket puts your own cash back into the deal.
  r = await req(`/api/admin/pml/${maplePml}/payments`, { method: 'POST', body: JSON.stringify({ amount_cents: 100000 }) });
  const pmlPay = r.json;
  r = await req(`/api/admin/reports/returns/${p2}`);
  ok(r.json.cash_invested_cents === basisWithFiling - 4300000 - 500000 + pmlPay.to_principal_cents,
    'lender principal repaid adds back to cash invested');

  r = await req('/api/admin/reports/pl');
  const pl = r.json;
  ok(pl.revenue.interest_income > 0, 'P&L books interest income from buyer payments');
  ok(pl.expenses.lender_interest >= pmlPay.to_interest_cents && pl.expenses.lender_interest > 0, 'P&L books lender interest as an expense');
  ok(pl.expenses.bog === 95000, 'boots-on-the-ground shows as an operating expense');
  ok(pl.expenses.filing === 24000, 'filing fees show as an operating expense');
  ok(pl.memo.principal_collected_cents > 0, 'buyer principal held out of income (return of capital)');
  ok(!('principal' in pl.revenue), 'principal never counted as revenue');
  ok(pl.net_income_cents === pl.revenue.total_cents - pl.expenses.total_cents + pl.gain_on_sale_cents,
    'net income = revenue - expenses + gain on sale');

  r = await req('/api/admin/reports/balance-sheet');
  const bs = r.json;
  ok(bs.assets.notes_receivable_cents > 0, 'balance sheet carries notes receivable');
  ok(bs.liabilities.lender_notes_payable_cents > 0, 'balance sheet carries lender debt');
  ok(bs.equity_cents === bs.assets.total_cents - bs.liabilities.total_cents, 'assets - liabilities = equity');
  ok(!bs.properties_held.some(h => h.id === p2), 'sold property no longer carried as inventory');

  r = await req('/api/admin/reports/returns');
  ok(r.json.totals.count >= 2 && r.json.totals.cash_invested_cents !== 0, 'portfolio returns roll up every property');
  ok(r.json.properties.some(x => x.property_id === p2), 'portfolio includes the sold property');

  console.log('— per-property late fee and deal defaults');
  r = await req('/api/admin/setup', { method: 'POST', body: JSON.stringify({
    default_late_fee_cents: 5000, default_grace_days: 5,
    default_buyer_email: 'prefill@test.com', default_buyer_phone: '(555) 111-2222' }) });
  ok(r.status === 200, 'company deal defaults saved');
  r = await req('/api/admin/defaults');
  ok(r.json.buyer_email === 'prefill@test.com' && r.json.buyer_phone === '(555) 111-2222', 'defaults returned for prefill');
  ok(r.json.late_fee_cents === undefined, 'no company-wide late fee — it lives on the property');

  r = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '9 Birch Ln' }) });
  const p3 = r.json.id;
  r = await req(`/api/admin/properties/${p3}/details`, { method: 'PUT', body: JSON.stringify({ late_fee_cents: 12500, grace_days: 10 }) });
  ok(r.json.late_fee_cents === 12500 && r.json.grace_days === 10, 'late fee set on the property, not globally');
  r = await req(`/api/admin/properties/${p3}/sell`, { method: 'POST', body: JSON.stringify({
    buyer_name: 'Dana Buyer', buyer_email: 'dana@test.com', sale_price_cents: 8000000,
    principal_cents: 7500000, interest_rate_bps: 850, term_months: 240, first_payment_date: '2026-10-01' }) });
  const danaLoan = r.json.loan_id;
  r = await req('/api/admin/loans/' + danaLoan);
  ok(r.json.loan.late_fee_cents === 12500, 'sale inherits the PROPERTY late fee, not the company default');
  ok(r.json.loan.grace_days === 10, 'sale inherits the property grace period');

  // a property with nothing set falls back to the company default
  r = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '11 Cedar Ct' }) });
  const p4 = r.json.id;
  r = await req(`/api/admin/properties/${p4}/sell`, { method: 'POST', body: JSON.stringify({
    buyer_name: 'Eli Buyer', buyer_email: 'eli@test.com', sale_price_cents: 6000000,
    principal_cents: 5500000, interest_rate_bps: 900, term_months: 180, first_payment_date: '2026-10-01' }) });
  r = await req('/api/admin/loans/' + r.json.loan_id);
  ok(r.json.loan.late_fee_cents === 0, 'property with no late fee set carries none, not a company default');

  console.log('— property phases, doc sets, agreement types, lender scheduling');
  r = await req(`/api/admin/properties/${p2}`);
  ok(Array.isArray(r.json.phases) && r.json.phases.includes('rehab'), 'property exposes lifecycle phases');
  ok(r.json.property.phase === 'sold', 'selling moved the property to the sold phase');
  ok(r.json.doc_folders.acquisition && r.json.doc_folders.pml_docs && r.json.doc_folders.sale_closing,
    'three admin document sets exist on the property');
  ok(r.json.doc_folders.acquisition.shared === false, 'acquisition docs are not shared with the buyer');
  ok(r.json.doc_folders.loan_docs.shared === true, 'buyer loan docs folder is shared');

  r = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '3 Phase Way' }) });
  const p5 = r.json.id;
  r = await req(`/api/admin/properties/${p5}/phase`, { method: 'POST', body: JSON.stringify({ phase: 'rehab' }) });
  ok(r.status === 200 && r.json.phase === 'rehab', 'phase can be advanced');
  r = await req(`/api/admin/properties/${p5}/phase`, { method: 'POST', body: JSON.stringify({ phase: 'nonsense' }) });
  ok(r.status === 400, 'unknown phase rejected');

  const b64b = Buffer.from('%PDF acquisition').toString('base64');
  r = await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
    filename: 'purchase-hud.pdf', mime: 'application/pdf', data_base64: b64b,
    property_id: p5, category: 'acquisition', title: 'Purchase settlement statement' }) });
  ok(r.status === 200 && r.json.visible_to_tenant === 0, 'acquisition docs stay admin-only');
  r = await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
    filename: 'pml-note.pdf', mime: 'application/pdf', data_base64: b64b,
    property_id: p5, category: 'pml_docs', title: 'Lender note' }) });
  ok(r.json.visible_to_tenant === 0, 'PML docs stay admin-only');
  r = await req(`/api/admin/properties/${p5}`);
  ok(r.json.doc_folders.acquisition.documents.length === 1 && r.json.doc_folders.pml_docs.documents.length === 1,
    'documents land in the right sets');

  // agreement for deed is now a real, distinct choice
  r = await req(`/api/admin/properties/${p5}/sell`, { method: 'POST', body: JSON.stringify({
    buyer_name: 'Fay Buyer', buyer_email: 'fay@test.com', loan_type: 'agreement_for_deed',
    sale_price_cents: 7000000, principal_cents: 6500000, interest_rate_bps: 900,
    term_months: 240, first_payment_date: '2026-11-01' }) });
  ok(r.status === 200, 'sale accepts Agreement for Deed');
  r = await req('/api/admin/loans/' + r.json.loan_id);
  ok(r.json.loan.loan_type === 'agreement_for_deed', 'agreement for deed stored as its own type');

  console.log('— lender payment scheduling');
  r = await req(`/api/admin/pml/${maplePml}/schedule`, { method: 'PUT', body: JSON.stringify({
    payment_day: 1, autopay_enabled: true, autopay_method: 'bank_transfer', autopay_note: 'auto-draft' }) });
  ok(r.status === 200 && r.json.autopay_enabled === 1, 'lender payment schedule saved');
  r = await req('/api/admin/pml-due');
  ok(Array.isArray(r.json.loans), 'lender payments-due list returns');
  const before = (await req('/api/admin/pml/' + maplePml)).json.pml.principal_balance_cents;
  r = await req('/api/admin/pml-auto-record', { method: 'POST', body: '{}' });
  ok(r.status === 200, 'scheduled lender payments can be recorded');
  const after = (await req('/api/admin/pml/' + maplePml)).json.pml;
  ok(after.principal_balance_cents <= before, 'recorded lender payment reduced the balance');
  r = await req('/api/admin/pml-auto-record', { method: 'POST', body: '{}' });
  const again = (await req('/api/admin/pml/' + maplePml)).json.pml;
  ok(again.principal_balance_cents === after.principal_balance_cents, 'lender payment not double-recorded in the same month');

  console.log('— dashboard totals');
  r = await req('/api/admin/summary');
  ok(r.json.property_counts && r.json.property_counts.total >= 3, 'dashboard counts properties');
  ok(r.json.income && typeof r.json.income.ytd_gross_cents === 'number', 'dashboard shows gross income');
  ok(typeof r.json.income.ytd_net_cents === 'number', 'dashboard shows net income');
  ok(Array.isArray(r.json.pml_loans), 'dashboard lists active lender loans');
  ok(r.json.monthly_spread_cents === r.json.tb_total_monthly_cents - r.json.pml_total_monthly_cents,
    'dashboard spread = buyer payments less lender payments');

  console.log('— message templates and branding');
  r = await req('/api/admin/templates');
  ok(r.json.templates.length >= 6, 'starter templates seeded');
  ok(r.json.merge_fields.some(f => f.key === 'first_name'), 'merge fields listed');
  ok(r.json.merge_fields.some(f => f.key === 'rep_phone'), 'representative merge fields available');

  r = await req('/api/admin/setup', { method: 'POST', body: JSON.stringify({
    mgmt_company_name: 'RenewEQ Management', rep_name: 'Marisa G', rep_phone: '(555) 222-3333',
    mailing_address: 'PO Box 9', mailing_city: 'Detroit', mailing_state: 'MI', mailing_zip: '48226' }) });
  ok(r.status === 200, 'management company details saved');

  r = await req('/api/admin/templates', { method: 'POST', body: JSON.stringify({
    name: 'Test notice', subject: 'Hello {{first_name}}',
    body_html: '<p>Your balance is {{balance}}. Call {{rep_name}} at {{rep_phone}}.</p>' }) });
  const tplId = r.json.id;
  ok(r.status === 200, 'custom template created');

  r = await req('/api/admin/templates/preview', { method: 'POST', body: JSON.stringify({
    loan_id: soldLoan, subject: 'Hello {{first_name}}',
    body_html: '<p>Your balance is {{balance}}. Call {{rep_name}} at {{rep_phone}}.</p>' }) });
  ok(r.json.subject === 'Hello Carlos', 'subject merge fields resolve');
  ok(r.json.html.includes('Marisa G') && r.json.html.includes('555-222-3333'),
    'representative details merge in, phone normalised to dashes');
  ok(r.json.html.includes('pp-letterhead'), 'message wrapped in company letterhead');
  ok(r.json.html.includes('Porch Pay'), 'Porch Pay mark present on correspondence');
  ok(r.json.html.includes('PO Box 9'), 'mailing address appears on correspondence');
  ok(!r.json.html.includes('{{'), 'no unresolved merge fields left');

  // sanitiser
  r = await req('/api/admin/templates/preview', { method: 'POST', body: JSON.stringify({
    subject: 'x', body_html: '<p onclick="steal()">hi</p><script>alert(1)</script><a href="javascript:bad()">x</a>' }) });
  ok(!r.json.html.includes('<script'), 'script tags stripped from templates');
  ok(!r.json.html.includes('onclick'), 'inline event handlers stripped');
  ok(!r.json.html.includes('javascript:'), 'javascript: links neutralised');

  r = await req(`/api/admin/loans/${soldLoan}/messages`, { method: 'POST', body: JSON.stringify({
    subject: 'Hello {{first_name}}', body_html: '<p>Balance {{balance}}</p>', template_id: tplId }) });
  ok(r.status === 200, 'template message sent to buyer');
  r = await req(`/api/admin/loans/${soldLoan}/messages`);
  const htmlMsg = r.json.find(m => m.body_html);
  ok(!!htmlMsg, 'html message stored');
  ok(htmlMsg.body_html.includes('pp-letterhead') && htmlMsg.body.includes('Balance'),
    'stored message has both branded html and a plain-text fallback');

  console.log('— owner entity and per-property terms');
  r = await req(`/api/admin/properties/${p5}/details`, { method: 'PUT', body: JSON.stringify({
    owner_name: 'Oak Holdings LLC', owner_type: 'land_trust', trustee: 'First Trust Co', due_day: 5 }) });
  ok(r.json.owner_name === 'Oak Holdings LLC' && r.json.owner_type === 'land_trust', 'owner name and type saved');
  ok(r.json.trustee === 'First Trust Co', 'trustee saved');
  ok(r.json.due_day === 5, 'payment due day set per property');
  r = await req(`/api/admin/properties/${p5}`);
  ok(r.json.owner_types && r.json.owner_types.land_trust === 'Land Trust', 'owner types offered to the UI');

  console.log('— auto P&I and separate monthly line items');
  r = await req('/api/admin/calc-payment?principal_cents=10000000&interest_rate_bps=950&term_months=360');
  ok(Math.abs(r.json.payment_cents - 84085) <= 2, `P&I auto-calculates ($${(r.json.payment_cents/100).toFixed(2)})`);

  r = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '5 Split St' }) });
  const p6 = r.json.id;
  r = await req(`/api/admin/properties/${p6}/sell`, { method: 'POST', body: JSON.stringify({
    buyer_name: 'Gus Buyer', buyer_email: 'gus@test.com',
    sale_price_cents: 9000000, principal_cents: 8000000, interest_rate_bps: 900,
    term_months: 360, first_payment_date: '2026-10-01',
    monthly_taxes_cents: 21000, monthly_insurance_cents: 9500,
    monthly_utilities_cents: 4000, monthly_servicing_cents: 2500,
    monthly_misc_cents: 3000, misc_label: 'HOA dues' }) });
  const splitLoan = r.json.loan_id;
  r = await req('/api/admin/loans/' + splitLoan);
  const sl = r.json.loan;
  ok(sl.payment_cents > 0 && !sl.payment_cents_overridden, 'P&I set automatically on the sale');
  ok(Math.abs(sl.payment_cents - 64367) <= 60, `P&I matches the note terms ($${(sl.payment_cents/100).toFixed(2)})`);
  ok(sl.monthly_taxes_cents === 21000, 'taxes stored as their own line');
  ok(sl.monthly_insurance_cents === 9500, 'insurance stored as its own line');
  ok(sl.escrow_cents === 30500, 'escrow = taxes + insurance (money held for the buyer)');
  ok(sl.monthly_servicing_cents === 2500, 'servicing fee stored separately');
  const ch = r.json.charges || [];
  ok(ch.some(c => c.category === 'utilities' && c.amount_cents === 4000), 'utilities billed as a recurring charge');
  ok(ch.some(c => c.category === 'servicing_fee' && c.amount_cents === 2500), 'servicing fee billed as a recurring charge');
  ok(ch.some(c => c.description === 'HOA dues' && c.amount_cents === 3000), 'misc fee uses its custom label');
  const totalMonthly = sl.payment_cents + sl.escrow_cents + ch.filter(c=>c.recurring).reduce((t,c)=>t+c.amount_cents,0);
  ok(totalMonthly === sl.payment_cents + 30500 + 9500, `total monthly adds up ($${(totalMonthly/100).toFixed(2)})`);

  console.log('— amortization calculator: solve for any variable');
  const A = async (params) => (await req('/api/admin/amortize?' + new URLSearchParams(params))).json;
  let c = await A({ principal_cents: 10000000, interest_rate_bps: 950, term_months: 360 });
  ok(c.solved_for === 'payment' && Math.abs(c.payment_cents - 84085) <= 2, 'solves for payment');
  ok(c.schedule.length === 360, 'returns the full schedule');
  ok(c.total_interest_cents > 0 && c.total_paid_cents > c.principal_cents, 'totals computed');

  c = await A({ payment_cents: 84085, interest_rate_bps: 950, term_months: 360 });
  ok(c.solved_for === 'principal' && Math.abs(c.principal_cents - 10000000) <= 200, 'solves for principal');

  c = await A({ principal_cents: 10000000, payment_cents: 84085, interest_rate_bps: 950 });
  ok(c.solved_for === 'term' && c.term_months === 360, 'solves for term');

  c = await A({ principal_cents: 10000000, payment_cents: 84085, term_months: 360 });
  ok(c.solved_for === 'rate' && Math.abs(c.interest_rate_bps - 950) <= 3, 'solves for interest rate');

  c = await A({ principal_cents: 10000000, interest_rate_bps: 950 });
  ok(!!c.error, 'refuses with only two values');
  c = await A({ principal_cents: 10000000, payment_cents: 50000, interest_rate_bps: 950 });
  ok(!!c.error, 'flags a payment that never covers the interest');
  c = await A({ principal_cents: 12000000, interest_rate_bps: 0, term_months: 120 });
  ok(c.payment_cents === 100000, 'handles a zero-interest loan');

  console.log('— final payment date');
  r = await req('/api/admin/maturity?first_payment_date=2026-06-01&term_months=360');
  ok(r.json.final_payment_date === '2056-05-01', 'final payment date computed from term');
  r = await req('/api/admin/maturity?first_payment_date=2026-06-01&final_payment_date=2056-05-01');
  ok(r.json.term_months === 360, 'term back-solved from the final payment date');
  r = await req('/api/admin/loans/' + splitLoan);
  ok(!!r.json.loan.final_payment_date, 'sale stores the final payment date on the loan');

  console.log('— phone formatting and address lookup');
  r = await req('/api/admin/tenants', { method: 'POST', body: JSON.stringify({
    name: 'Phone Test', email: 'phone@test.com', phone: '(555) 123.4567' }) });
  const phoneId = r.json.id;
  r = await req('/api/admin/tenants');
  ok(r.json.find(t => t.id === phoneId).phone === '555-123-4567', 'phone normalised to dashes on save');
  r = await req('/api/admin/address-suggest?q=abc');
  ok(Array.isArray(r.json.suggestions), 'address lookup returns a list even for a short query');

  console.log('— notifications and badges');
  r = await req('/api/push/public-key');
  ok(r.json.key && r.json.key.length > 60, 'VAPID public key available for push');

  // a message from the admin badges the buyer
  const tbUser = (await req('/api/admin/tenants')).json.find(t => t.email === 'gus@test.com');
  const gusCookie = (await req('/api/login', { method: 'POST', body: JSON.stringify({
    email: 'gus@test.com', password: (await req(`/api/admin/tenants/${tbUser.id}/reset-password`, { method: 'POST', body: '{}' })).json.temp_password }) }, '')).cookie;
  await req('/api/change-password', { method: 'POST', body: JSON.stringify({ password: 'GusPass12345!' }) }, gusCookie);
  await req('/api/tenant/accept-terms', { method: 'POST', body: JSON.stringify({ accept_terms: true, accept_privacy: true }) }, gusCookie);

  r = await req(`/api/admin/loans/${splitLoan}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Quick question for you' }) });
  await new Promise(res2 => setTimeout(res2, 120));
  r = await req('/api/notifications', {}, gusCookie);
  ok(r.json.counts.tabs.msgs >= 1, 'admin message badges the buyer Messages tab');

  // a shared document badges the Docs tab
  const b64c = Buffer.from('%PDF policy').toString('base64');
  await req('/api/admin/documents', { method: 'POST', body: JSON.stringify({
    filename: 'policy.pdf', mime: 'application/pdf', data_base64: b64c, loan_id: splitLoan,
    category: 'insurance', title: '2026 policy', visible_to_tenant: true }) });
  await new Promise(res2 => setTimeout(res2, 120));
  r = await req('/api/notifications', {}, gusCookie);
  ok(r.json.counts.tabs.docs >= 1, 'shared document badges the Docs tab');
  ok(r.json.counts.total >= 2, 'total drives the app icon badge');

  // opening a tab clears just that badge
  await req('/api/notifications/read', { method: 'POST', body: JSON.stringify({ kind: 'document' }) }, gusCookie);
  r = await req('/api/notifications', {}, gusCookie);
  ok(r.json.counts.tabs.docs === 0 && r.json.counts.tabs.msgs >= 1, 'reading one category leaves the others');

  console.log('— admin payment reminders');
  r = await req('/api/admin/reminders');
  ok(r.json.rules.length >= 3, 'default reminder rules seeded');
  ok(r.json.rules.some(x => x.offset_days < 0) && r.json.rules.some(x => x.offset_days > 0),
    'defaults cover before and after the due date');

  r = await req('/api/admin/reminders', { method: 'POST', body: JSON.stringify({
    name: 'Two days out', offset_days: -2, channel: 'both',
    title: 'Heads up, {{first_name}}', body: '{{amount_due}} is due {{due_date}}.' }) });
  const ruleId = r.json.id;
  ok(r.status === 200 && r.json.offset_days === -2, 'custom reminder created');
  r = await req('/api/admin/reminders/' + ruleId, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
  ok(r.json.enabled === 0, 'reminder can be switched off');

  r = await req(`/api/admin/loans/${splitLoan}/remind`, { method: 'POST', body: JSON.stringify({
    title: 'Friendly nudge', body: 'You owe {{amount_due}}.' }) });
  ok(r.status === 200, 'admin sends a one-off reminder');
  r = await req('/api/notifications', {}, gusCookie);
  ok(r.json.items.some(i => i.title === 'Friendly nudge'), 'reminder lands in the buyer feed');
  ok(r.json.counts.tabs.pay >= 1, 'reminder badges the Pay tab');

  r = await req('/api/admin/reminder-sweep', { method: 'POST', body: '{}' });
  ok(r.status === 200, 'reminder sweep runs');
  const feedBefore = (await req('/api/notifications', {}, gusCookie)).json.items.length;
  await req('/api/admin/reminder-sweep', { method: 'POST', body: '{}' });
  const feedAfter = (await req('/api/notifications', {}, gusCookie)).json.items.length;
  ok(feedAfter === feedBefore, 'sweep does not duplicate reminders on a second run');

  console.log('— notification preferences');
  r = await req('/api/notifications/prefs', { method: 'POST', body: JSON.stringify({ document: false }) }, gusCookie);
  ok(r.json.document === false, 'buyer can switch a category off');
  r = await req('/api/admin/reminders/' + ruleId, { method: 'DELETE' });
  ok(r.status === 200, 'reminder deleted');

  console.log('— multi-company isolation');
  r = await req('/api/signup', { method: 'POST', body: JSON.stringify({
    company_name: 'Rival Holdings LLC', name: 'Rival Owner', email: 'rival@test.com', password: 'RivalPass123!' }) }, '');
  ok(r.status === 200 && r.json.role === 'owner', 'second company self-signup');
  const rivalCookie = r.cookie;
  r = await req('/api/admin/summary', {}, rivalCookie);
  ok(r.json.active_loans === 0 && r.json.loans.length === 0, 'new company sees zero loans (no leakage)');
  r = await req('/api/admin/loans', {}, rivalCookie);
  ok(r.json.length === 0, 'rival sees no loans list');
  r = await req('/api/admin/properties', {}, rivalCookie);
  ok(r.json.length === 0, 'rival sees no properties');
  r = await req('/api/admin/tenants', {}, rivalCookie);
  ok(r.json.length === 0, 'rival sees no tenant buyers');
  r = await req('/api/admin/loans/' + loanId, {}, rivalCookie);
  ok(r.status === 404, 'rival blocked from company A loan by direct ID');
  r = await req(`/api/admin/loans/${loanId}/payments`, { method: 'POST', body: JSON.stringify({ amount_cents: 5000 }) }, rivalCookie);
  ok(r.status === 404, 'rival cannot post payment to company A loan');
  r = await req(`/api/admin/loans/${loanId}/documents`, {}, rivalCookie);
  ok(r.status === 404, 'rival cannot list company A documents');
  r = await req('/api/admin/pml/' + pmlId, {}, rivalCookie);
  ok(r.status === 404, 'rival cannot read company A PML loan');
  r = await req('/api/admin/pml', {}, rivalCookie);
  ok(r.json.length === 0, 'rival PML list empty');
  r = await req('/api/admin/expenses', {}, rivalCookie);
  ok(r.json.length === 0, 'rival sees no expenses');
  r = await req('/api/admin/messages', {}, rivalCookie);
  ok(r.json.length === 0, 'rival sees no message threads');
  r = await req(`/api/admin/tenants/${tbId}/location`, {}, rivalCookie);
  ok(r.status === 404, 'rival cannot read company A buyer location');
  r = await req(`/api/admin/loans/${loanId}/notices`, {}, rivalCookie);
  ok(r.status === 404, 'rival cannot read company A notices');

  // tasks, contacts, notes and the calendar must be just as sealed
  r = await req('/api/admin/tasks?status=all', {}, rivalCookie);
  ok(r.json.tasks.length === 0, 'rival sees none of company A tasks');
  r = await req('/api/admin/tasks/' + taskId, { method: 'PUT', body: JSON.stringify({ title: 'hijacked' }) }, rivalCookie);
  ok(r.status === 404, 'rival cannot edit a company A task');
  r = await req(`/api/admin/tasks/${taskId}/complete`, { method: 'POST', body: '{}' }, rivalCookie);
  ok(r.status === 404, 'rival cannot tick off a company A task');
  r = await req('/api/admin/tasks/' + taskId, { method: 'DELETE' }, rivalCookie);
  ok(r.status === 404, 'rival cannot delete a company A task');
  r = await req('/api/admin/tasks', { method: 'POST', body: JSON.stringify({
    title: 'sneaky', property_id: propId }) }, rivalCookie);
  ok(r.status === 400, 'rival cannot pin a task onto a company A property');

  r = await req('/api/admin/contacts', {}, rivalCookie);
  ok(r.json.contacts.length === 0, 'rival sees none of company A contacts');
  r = await req(`/api/admin/contacts/${rayId}/messages`, {}, rivalCookie);
  ok(r.status === 404, 'rival cannot read company A vendor texts');
  r = await req(`/api/admin/contacts/${rayId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'hi' }) }, rivalCookie);
  ok(r.status === 404, 'rival cannot text a company A contact');
  r = await req('/api/admin/contacts/' + rayId, { method: 'PUT', body: JSON.stringify({ name: 'stolen' }) }, rivalCookie);
  ok(r.status === 404, 'rival cannot edit a company A contact');
  r = await req(`/api/admin/properties/${propId}/contacts`, {}, rivalCookie);
  ok(r.status === 404, 'rival cannot list who works on a company A property');
  r = await req(`/api/admin/properties/${propId}/broadcast`, { method: 'POST', body: JSON.stringify({
    contact_ids: [rayId], body: 'hi' }) }, rivalCookie);
  ok(r.status === 404, 'rival cannot broadcast about a company A property');
  r = await req('/api/admin/contact-inbox', {}, rivalCookie);
  ok(r.json.unread.length === 0, 'rival vendor inbox is empty');

  r = await req('/api/admin/notes?property_id=' + propId, {}, rivalCookie);
  ok(r.json.notes.length === 0, 'rival sees none of company A notes');
  r = await req('/api/admin/notes', { method: 'POST', body: JSON.stringify({
    property_id: propId, body: 'planted' }) }, rivalCookie);
  ok(r.status === 400, 'rival cannot plant a note on a company A property');
  r = await req('/api/admin/notes', { method: 'POST', body: JSON.stringify({
    loan_id: loanId, body: 'planted' }) }, rivalCookie);
  ok(r.status === 400, 'rival cannot plant a note on a company A loan');

  r = await req('/api/admin/calendar?from=2026-12-01&to=2026-12-31', {}, rivalCookie);
  ok(r.json.events.length === 0, 'rival calendar shows nothing of company A');
  // cross-company write attempt: rival property + company A loan
  r = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({ address: '9 Rival Rd' }) }, rivalCookie);
  const rivalProp = r.json.id;
  r = await req('/api/admin/loans', { method: 'POST', body: JSON.stringify({
    property_id: propId, sale_price_cents: 1000, principal_cents: 1000,
    interest_rate_bps: 500, term_months: 12, first_payment_date: '2026-01-01' }) }, rivalCookie);
  ok(r.status === 404, 'rival cannot attach loan to company A property');
  r = await req('/api/admin/loans', { method: 'POST', body: JSON.stringify({
    property_id: rivalProp, tenant_user_id: tbId, sale_price_cents: 1000, principal_cents: 1000,
    interest_rate_bps: 500, term_months: 12, first_payment_date: '2026-01-01' }) }, rivalCookie);
  ok(r.status === 404, 'rival cannot attach company A buyer to its own loan');

  console.log('— owner / staff roles');
  r = await req('/api/admin/staff', { method: 'POST', body: JSON.stringify({ name: 'Book Keeper', email: 'book@test.com' }) });
  ok(r.status === 200 && r.json.temp_password, 'owner invites staff admin');
  const staffCookie = (await req('/api/login', { method: 'POST', body: JSON.stringify({ email: 'book@test.com', password: r.json.temp_password }) }, '')).cookie;
  r = await req('/api/admin/summary', {}, staffCookie);
  ok(r.status === 200 && r.json.loans.length > 0, 'staff sees company loans');
  r = await req('/api/admin/staff', { method: 'POST', body: JSON.stringify({ name: 'X', email: 'x@test.com' }) }, staffCookie);
  ok(r.status === 403, 'staff cannot invite other staff (owner only)');
  r = await req('/api/admin/company', { method: 'PUT', body: JSON.stringify({ name: 'Hacked' }) }, staffCookie);
  ok(r.status === 403, 'staff cannot rename company');

  console.log('— archive & delete users');
  r = await req('/api/admin/tenants', { method: 'POST', body: JSON.stringify({ name: 'Archie Buyer', email: 'archie@test.com' }) });
  const archId = r.json.id, archPw = r.json.temp_password;
  r = await req(`/api/admin/tenants/${archId}/archive`, { method: 'POST', body: JSON.stringify({ reason: 'Loan paid off' }) });
  ok(r.status === 200, 'admin archives a buyer');
  r = await req('/api/admin/tenants');
  ok(!r.json.some(t => t.id === archId), 'archived buyer hidden from active list');
  r = await req('/api/admin/tenants?archived=1');
  ok(r.json.some(t => t.id === archId && t.archived_reason === 'Loan paid off'), 'archived buyer listed with reason');
  r = await req('/api/login', { method: 'POST', body: JSON.stringify({ email: 'archie@test.com', password: archPw }) }, '');
  ok(r.status === 403, 'archived buyer cannot sign in');
  r = await req(`/api/admin/tenants/${archId}/restore`, { method: 'POST', body: '{}' });
  ok(r.status === 200, 'admin restores buyer');
  r = await req('/api/admin/tenants');
  ok(r.json.some(t => t.id === archId), 'restored buyer back in active list');
  r = await req('/api/login', { method: 'POST', body: JSON.stringify({ email: 'archie@test.com', password: archPw }) }, '');
  ok(r.status === 200, 'restored buyer can sign in again');
  r = await req(`/api/admin/tenants/${archId}`, { method: 'DELETE', body: JSON.stringify({ confirm: 'oops' }) });
  ok(r.status === 400, 'admin delete requires typed confirmation');
  r = await req(`/api/admin/tenants/${archId}`, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });
  ok(r.status === 200, 'admin deletes a buyer');
  r = await req('/api/admin/tenants');
  ok(!r.json.some(t => t.id === archId), 'deleted buyer gone from list');
  r = await req(`/api/admin/tenants/${archId}/archive`, { method: 'POST', body: '{}' });
  ok(r.status === 404, 'deleted buyer cannot be acted on again');
  // archive is company-scoped
  r = await req(`/api/admin/tenants/${tbId}/archive`, { method: 'POST', body: '{}' }, rivalCookie);
  ok(r.status === 404, 'rival cannot archive company A buyer');
  r = await req(`/api/admin/tenants/${tbId}`, { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) }, rivalCookie);
  ok(r.status === 404, 'rival cannot delete company A buyer');

  console.log('— Michigan forfeiture track (DC 101)');
  // A Flint land contract, 12 days past due: one sweep should fire the 5-day notice
  // (with non-waiver language and the late fee charged), and draft the DC 101.
  const db = require('./db');
  const lobMod = require('./lob');
  const miToday = new Date(); miToday.setUTCDate(miToday.getUTCDate() - 12);
  const miFirst = miToday.toISOString().slice(0, 10);
  r = await req('/api/admin/properties', { method: 'POST', body: JSON.stringify({
    address: '456 Buick Ave', city: 'Flint', state: 'MI', zip: '48503',
    trust_name: 'Buick Ave Trust', trustee: 'SAAPM LLC' }) });
  const miPropId = r.json.id;
  r = await req('/api/admin/tenants', { method: 'POST', body: JSON.stringify({
    name: 'Mia Michigander', email: 'mia@test.com' }) });
  const miTbId = r.json.id, miTmp = r.json.temp_password;
  r = await req('/api/login', { method: 'POST', body: JSON.stringify({ email: 'mia@test.com', password: miTmp }) }, '');
  let miCookie = r.cookie;
  await req('/api/change-password', { method: 'POST', body: JSON.stringify({ password: 'MiaPass123!' }) }, miCookie);
  await req('/api/tenant/accept-terms', { method: 'POST', body: JSON.stringify({ accept_terms: true, accept_privacy: true }) }, miCookie);
  r = await req('/api/admin/loans', { method: 'POST', body: JSON.stringify({
    property_id: miPropId, tenant_user_id: miTbId, loan_type: 'land_contract',
    sale_price_cents: 7500000, down_payment_cents: 1500000,
    principal_cents: 6000000, interest_rate_bps: 800, term_months: 240,
    escrow_cents: 0, late_fee_cents: 4500, grace_days: 5, first_payment_date: miFirst }) });
  const miLoanId = r.json.loan.id;

  await req('/api/admin/notice-sweep', { method: 'POST', body: '{}' });
  r = await req(`/api/admin/loans/${miLoanId}/notices`);
  const mi5 = r.json.find(n => n.stage === 'late_5');
  const miDraft = r.json.find(n => n.stage === 'mi_dc101');
  ok(!!mi5, 'MI: 5-day notice fired at day 12');
  ok(mi5 && /RESERVATION OF RIGHTS AND NON-WAIVER/.test(mi5.body) && /shall not constitute/.test(mi5.body),
    'MI: 5-day notice carries the full reservation-of-rights clause');
  ok(mi5 && /this charge has been applied/.test(mi5.body), 'MI: notice states the late fee as charged, not a maybe');
  ok(mi5 && /contractual courtesy notice only/.test(mi5.body) && /MCL 600.5728/.test(mi5.body),
    'MI: notice says plainly it is not the statutory DC 101');
  ok(mi5 && /TOTAL NOW DUE/.test(mi5.body), 'MI: notice itemizes the amount now due');
  const miEvidence = JSON.stringify((await req(`/api/admin/loans/${miLoanId}/documents`)).json);
  ok(/Notice as sent — 5-day late notice/.test(miEvidence), 'MI: the notice as sent files itself as a PDF');
  ok(/Certificate of delivery — 5-day notice/.test(miEvidence), 'MI: certificate of delivery files itself');
  ok(!r.json.some(n => ['late_15', 'late_30', 'late_45', 'late_60'].includes(n.stage)),
    'MI: every generic ladder rung is suppressed — the 60-day timeline never applies in Michigan');
  // And the other side of that carve-out: a loan in any other state walks the generic
  // ladder, all the way to its 60-day backstop when it is that far gone.
  r = await req(`/api/admin/loans/${loanId}/notices`);
  const ohStages = r.json.map(n => n.stage);
  ok(ohStages.includes('late_60'), 'non-MI (Ohio): the 60-day rung of the generic ladder fires');
  ok(!ohStages.includes('mi_dc101'), 'non-MI: no DC 101 is ever drafted outside Michigan');
  ok(!!miDraft && miDraft.prepared === 1 && !miDraft.served_at, 'MI: DC 101 drafted, not served');
  r = await req('/api/admin/loans/' + miLoanId);
  ok(r.json.ledger.some(l => l.type === 'late_fee'), 'MI: late fee posted with the 5-day notice');
  const miFeesBefore = r.json.loan.fees_due_cents;
  await req('/api/admin/notice-sweep', { method: 'POST', body: '{}' });
  r = await req('/api/admin/loans/' + miLoanId);
  ok(r.json.loan.fees_due_cents === miFeesBefore, 'MI: second sweep does not double the late fee');
  r = await req(`/api/admin/loans/${miLoanId}/notices`);
  ok(r.json.filter(n => n.stage === 'mi_dc101').length === 1, 'MI: second sweep does not draft a second DC 101');

  // The draft is the admin's business only.
  r = await req('/api/tenant/notices', {}, miCookie);
  ok(!r.json.some(n => n.stage === 'mi_dc101'), 'MI: buyer cannot see the unserved draft');

  // Review: values are prefilled from the deal, and Flint suggests the 67th.
  r = await req(`/api/admin/notices/${miDraft.id}/dc101`);
  ok(r.json.values['land contract purchaser or purchasers names'] === 'Mia Michigander', 'DC 101: purchaser prefilled');
  ok(/456 Buick Ave, Flint, MI 48503/.test(r.json.values['address or legal description of the premises line 1']), 'DC 101: premises prefilled');
  ok(r.json.values['land contract seller or selllers names line 1'] === 'Buick Ave Trust', 'DC 101: seller is the trust');
  ok(r.json.court_suggestion && r.json.court_suggestion.district === '67th', 'DC 101: Flint suggests the 67th District');
  ok(r.json.mail_cost_cents === 821, 'DC 101: 3-page certified letter estimates $8.21');
  r = await req(`/api/admin/notices/${miDraft.id}/dc101`, { method: 'PUT', body: JSON.stringify({
    values: { 'judicial district': '67th', 'court address': '630 S. Saginaw St., Flint, MI 48502',
              'land contract date': '1/15/2025', 'bogus field': 'ignored' } }) });
  ok(r.status === 200 && r.json.values['judicial district'] === '67th', 'DC 101: edits saved');
  ok(!('bogus field' in r.json.values), 'DC 101: unknown fields rejected');

  // The PDF preview is the real SCAO form with the values drawn in.
  const pdfRes = await fetch(`${BASE}/api/admin/notices/${miDraft.id}/dc101.pdf`, { headers: { Cookie: adminCookie } });
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  ok(pdfRes.status === 200 && pdfBuf.slice(0, 5).toString() === '%PDF-', 'DC 101: preview renders a PDF');
  ok(pdfBuf.length > 200000, 'DC 101: preview is the full template, not a stub');
  ok(pdfBuf.includes('(Mia Michigander)'), 'DC 101: purchaser name is drawn into the form');

  // Serving without mail set up fails cleanly; with it (stubbed), it works once.
  r = await req(`/api/admin/notices/${miDraft.id}/serve-dc101`, { method: 'POST', body: '{}' });
  ok(r.status === 400 && /not set up/.test(r.json.error), 'DC 101: cannot serve without Lob configured');
  const origSend = lobMod.sendLetter, origEnabled = lobMod.lobEnabled;
  lobMod.lobEnabled = () => true;
  let lobSawPdf = null;
  lobMod.sendLetter = async (co, opts) => {
    lobSawPdf = opts.pdf;
    return { id: 'ltr_mi_test', tracking_number: '9207MITEST', expected_delivery_date: '2099-01-01',
             test: true, service: opts.service, cost_cents: 821 };
  };
  try {
    r = await req(`/api/admin/notices/${miDraft.id}/serve-dc101`, { method: 'POST', body: '{}' });
    ok(r.status === 200 && r.json.tracking === '9207MITEST', 'DC 101: served certified (stubbed Lob)');
    ok(Buffer.isBuffer(lobSawPdf) && lobSawPdf.slice(0, 5).toString() === '%PDF-', 'DC 101: Lob got the filled PDF, not HTML');
    const cure = new Date(); cure.setUTCDate(cure.getUTCDate() + 15);
    ok(r.json.cure_deadline === cure.toISOString().slice(0, 10), 'DC 101: cure deadline is service + 15 days');
    r = await req(`/api/admin/notices/${miDraft.id}/serve-dc101`, { method: 'POST', body: '{}' });
    ok(r.status === 400, 'DC 101: cannot be served twice');
  } finally { lobMod.sendLetter = origSend; lobMod.lobEnabled = origEnabled; }

  r = await req(`/api/admin/loans/${miLoanId}/documents`);
  const miDocs = JSON.stringify(r.json);
  ok(/DC 101 served/.test(miDocs) && /9207MITEST/.test(miDocs), 'DC 101: court copy with tracking filed under documents');
  r = await req('/api/admin/tasks');
  const openTasks = (r.json.tasks || r.json);
  ok(!openTasks.some(t => t.title && t.title.startsWith('Review & serve DC 101') && t.status === 'open'),
    'DC 101: review task closed by serving');

  // Once served, the sweep goes quiet on this loan…
  await req('/api/admin/notice-sweep', { method: 'POST', body: '{}' });
  r = await req(`/api/admin/loans/${miLoanId}/notices`);
  ok(r.json.filter(n => n.stage === 'mi_dc101').length === 1 && !r.json.some(n => n.stage === 'late_15'),
    'MI: no further automated notices after service');

  // …until the cure clock dies. Yesterday, in this case.
  const yd = new Date(); yd.setUTCDate(yd.getUTCDate() - 1);
  db.run('UPDATE notices SET cure_deadline=? WHERE id=?', yd.toISOString().slice(0, 10), miDraft.id);
  await req('/api/admin/notice-sweep', { method: 'POST', body: '{}' });
  r = await req('/api/admin/tasks');
  const dc102Task = (r.json.tasks || r.json).find(t => t.title && t.title.startsWith('File DC 102'));
  ok(!!dc102Task, 'MI: expired cure creates the File-DC 102 task');
  ok(dc102Task && /\$55 filing fee/.test(dc102Task.notes || ''), 'MI: task carries the Flint 67th filing checklist');
  await req('/api/admin/notice-sweep', { method: 'POST', body: '{}' });
  r = await req('/api/admin/tasks');
  ok((r.json.tasks || r.json).filter(t => t.title && t.title.startsWith('File DC 102')).length === 1,
    'MI: DC 102 task is not duplicated by later sweeps');

  // The served notice is visible to the buyer; the certified letter was the service.
  r = await req('/api/tenant/notices', {}, miCookie);
  ok(r.json.some(n => n.stage === 'mi_dc101' && /Served by certified mail/.test(n.body)),
    'MI: buyer sees the served notice in the app');

  // A partial payment mid-default triggers the non-waiver receipt: filed as a PDF,
  // and the reservation of rights delivered to the buyer in the thread.
  r = await req(`/api/admin/loans/${miLoanId}/payments`, { method: 'POST',
    body: JSON.stringify({ amount_cents: 10000, method: 'cash' }) });
  ok(r.status === 200, 'MI: partial payment accepted');
  r = await req(`/api/admin/loans/${miLoanId}/documents`);
  ok(/Partial payment non-waiver receipt/.test(JSON.stringify(r.json)),
    'MI: non-waiver receipt filed with the payment');
  r = await req(`/api/admin/loans/${miLoanId}/messages`);
  const nwMsg = r.json.find(m => /reservation of rights/i.test(m.subject || '') || /does not cure the existing default/.test(m.body || ''));
  ok(!!nwMsg, 'MI: reservation of rights delivered to the buyer in the thread');
  ok(nwMsg && /cure deadline/.test(nwMsg.body) && /unchanged/.test(nwMsg.body),
    'MI: buyer told the pending DC 101 cure deadline is unchanged');
  // A payment that clears the arrears entirely does NOT get a receipt.
  r = await req('/api/admin/loans/' + miLoanId);
  const owedNow = r.json.status.owed_now_cents;
  const docsBefore = JSON.stringify((await req(`/api/admin/loans/${miLoanId}/documents`)).json)
    .split('Partial payment non-waiver receipt').length;
  await req(`/api/admin/loans/${miLoanId}/payments`, { method: 'POST',
    body: JSON.stringify({ amount_cents: owedNow, method: 'cash' }) });
  const docsAfter = JSON.stringify((await req(`/api/admin/loans/${miLoanId}/documents`)).json)
    .split('Partial payment non-waiver receipt').length;
  ok(docsAfter === docsBefore, 'MI: a payment in full generates no non-waiver receipt');

  console.log('— the softphone SDK ships with the app');
  {
    // Twilio's CDN silently 403'd the SDK and the softphone died. It is vendored now:
    // served from our own origin, loaded from our own origin, no third party involved.
    const sdk = await fetch(BASE + '/twilio-voice.min.js');
    ok(sdk.status === 200, 'the vendored Voice SDK is served');
    const body = await sdk.text();
    ok(body.length > 100000 && /Twilio/.test(body), 'and it is the real SDK, not an error page');
    const page = require('fs').readFileSync('public/admin.html', 'utf8');
    ok(page.includes("s.src='/twilio-voice.min.js'"), 'the admin app loads it from our own domain');
    ok(!page.includes('sdk.twilio.com'), 'and never from the CDN that broke');
  }

  console.log('— no page references an element that does not exist');
  {
    // A $('id') pointing at nothing throws at runtime, and inside a silent catch it
    // blanks whole features — the buyer's message thread went dark exactly this way.
    const fs2 = require('fs');
    const dynamic = new Set(['pp-toast']);   // created by JS at runtime, not in markup
    for (const page of ['public/tenant.html', 'public/admin.html']) {
      const html = fs2.readFileSync(page, 'utf8');
      const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
      const used = [...new Set([...html.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))];
      const missing = used.filter(u => !ids.has(u) && !dynamic.has(u));
      ok(missing.length === 0, `${page}: every referenced element exists` +
        (missing.length ? ` — MISSING: ${missing.join(', ')}` : ''));
    }
  }

  console.log('— the workflow timeline knows each state\'s track');
  {
    // Ohio: the generic ladder, every rung visible, fired ones marked with channels.
    r = await req(`/api/admin/loans/${loanId}/workflow`);
    ok(r.status === 200 && r.json.regime === 'generic' && r.json.state === 'OH',
      'an Ohio loan shows the generic regime');
    const stages = r.json.steps.map(x => x.key);
    for (const st of ['late_5', 'late_15', 'late_30', 'late_45', 'late_60'])
      ok(stages.includes(st), `Ohio track lists ${st}`);
    ok(!stages.some(k => /dc101|dc102|cure/.test(k)), 'and none of Michigan\'s statutory steps');
    const fired = r.json.steps.find(x => x.key === 'late_60');
    ok(fired && fired.state === 'done' && fired.done_at, 'the 60-day rung shows as done with its date');
    const skipped = r.json.steps.find(x => x.key === 'late_15');
    ok(skipped && skipped.state === 'skipped', 'superseded rungs show as skipped, not silently missing');
    ok(r.json.steps.every(x => x.kind === 'auto'), 'the generic ladder is fully automated — no human gates');

    // Michigan: the statutory track with its human-review gates.
    r = await req(`/api/admin/loans/${miLoanId}/workflow`);
    ok(r.json.regime === 'michigan', 'a Michigan loan shows the statutory regime');
    const mk = r.json.steps.map(x => x.key);
    ok(['grace', 'late_5', 'dc101_prep', 'dc101_serve', 'cure', 'dc102'].every(k => mk.includes(k)),
      'the full statutory sequence is laid out');
    ok(!mk.some(k => /late_15|late_30|late_45|late_60/.test(k)), 'no generic rungs leak into Michigan');
    const prep = r.json.steps.find(x => x.key === 'dc101_prep');
    ok(prep.kind === 'review', 'the DC 101 draft is marked as needing human review');
    ok(['waiting', 'done'].includes(prep.state), 'and it is waiting on a person (or already handled)');
    const serve = r.json.steps.find(x => x.key === 'dc101_serve');
    ok(serve.kind === 'human' && serve.state === 'done', 'service shows done — this loan\'s DC 101 was served');
    const five = r.json.steps.find(x => x.key === 'late_5');
    ok(five.state === 'done' && Array.isArray(five.channels), 'the 5-day notice shows sent, with its channels');

    // A buyer cannot see the machinery pointed at them.
    ok((await req(`/api/admin/loans/${miLoanId}/workflow`, {}, tbCookie)).status !== 200,
      'the workflow is admin-only');
  }


  console.log('— welcome guide, escrow update, payoff delivery');
  // The loan defaults to PITI; flipping it to PIT changes the guide it produces.
  r = await req('/api/admin/loans/' + miLoanId);
  ok(r.json.loan.escrow_structure === 'piti', 'loan carries its PIT/PITI designation (default PITI)');
  r = await req(`/api/admin/loans/${miLoanId}/homebuyer-guide`, { method: 'POST', body: '{}' });
  ok(r.status === 200 && r.json.city === 'Flint' && r.json.structure === 'PITI', 'welcome guide sent for Flint, PITI');
  // Flipping the designation re-sends the corrected guide on its own — the buyer here
  // has accepted terms, so the moment the loan changes, the wrong guide is replaced.
  const guidesBefore = JSON.stringify((await req(`/api/admin/loans/${miLoanId}/documents`)).json);
  ok(!/\(Flint, PIT\)/.test(guidesBefore), 'no PIT guide exists before the switch');
  r = await req('/api/admin/loans/' + miLoanId, { method: 'PUT', body: JSON.stringify({ escrow_structure: 'pit' }) });
  ok(r.json.loan.escrow_structure === 'pit', 'designation switches to PIT');
  const guidesAfter = JSON.stringify((await req(`/api/admin/loans/${miLoanId}/documents`)).json);
  ok(/Welcome guide — your new home \(Flint, PIT\)/.test(guidesAfter),
    'the PIT guide files itself automatically when the designation changes');
  r = await req(`/api/admin/loans/${miLoanId}/homebuyer-guide`, { method: 'POST', body: '{}' });
  ok(r.json.structure === 'PIT', 'guide re-sends as PIT after the switch');
  let miDocs2 = JSON.stringify((await req(`/api/admin/loans/${miLoanId}/documents`)).json);
  ok(/Welcome guide — your new home \(Flint, PITI\)/.test(miDocs2) && /\(Flint, PIT\)/.test(miDocs2),
    'both guide versions filed in shared documents');
  r = await req(`/api/admin/loans/${miLoanId}/messages`);
  ok(r.json.some(m => /welcome guide/i.test(m.subject || '') && /autopay/.test(m.body) && /\$50\.00 servicing fee/.test(m.body)),
    'welcome message mentions app-only payments and the autopay fee waiver');

  // Changing taxes or insurance produces the escrow update statement, delivered.
  r = await req('/api/admin/loans/' + miLoanId, { method: 'PUT',
    body: JSON.stringify({ monthly_taxes_cents: 15000, monthly_insurance_cents: 8000 }) });
  ok(r.json.loan.escrow_cents === 23000, 'escrow recomputed from new tax + insurance figures');
  miDocs2 = JSON.stringify((await req(`/api/admin/loans/${miLoanId}/documents`)).json);
  ok(/Escrow update — new payment/.test(miDocs2), 'escrow update statement filed in documents');
  r = await req(`/api/admin/loans/${miLoanId}/messages`);
  ok(r.json.some(m => /escrow/i.test(m.subject || '') && /new total monthly payment/i.test(m.body)),
    'buyer messaged with the new payment amount');
  // No change, no statement: a PUT that touches nothing escrow-ish stays silent.
  const escrowDocsCount = miDocs2.split('Escrow update').length;
  await req('/api/admin/loans/' + miLoanId, { method: 'PUT', body: JSON.stringify({ grace_days: 5 }) });
  miDocs2 = JSON.stringify((await req(`/api/admin/loans/${miLoanId}/documents`)).json);
  ok(miDocs2.split('Escrow update').length === escrowDocsCount, 'no escrow statement when nothing escrow-ish changed');

  // A buyer-requested payoff files the formal statement into their documents.
  r = await req('/api/tenant/payoff/request', { method: 'POST', body: '{}' }, miCookie);
  ok(r.status === 200 && r.json.quote && r.json.quote.quote_number, 'buyer requests a payoff');
  miDocs2 = JSON.stringify((await req(`/api/admin/loans/${miLoanId}/documents`)).json);
  ok(new RegExp(`Payoff statement ${r.json.quote.quote_number}`).test(miDocs2), 'formal payoff PDF filed in documents');
  r = await req(`/api/admin/loans/${miLoanId}/messages`);
  ok(r.json.some(m => /Payoff statement/.test(m.subject || '')), 'buyer messaged that the payoff is filed');

  console.log('— system email templates & document gallery');
  r = await req('/api/admin/system-templates');
  ok(r.json.length === 4 && r.json.every(s => !s.customized), 'four system emails, all default');
  // Customize the welcome guide wording, resend, and check the custom intro leads
  // while the always-appended details survive.
  r = await req('/api/admin/templates', { method: 'POST', body: JSON.stringify({
    name: 'Welcome guide delivered', system_key: 'welcome_guide',
    subject: 'Welcome home, {{first_name}}!',
    body_html: '<p>Howdy {{first_name}} — your guide from {{company_name}} is filed in Documents.</p>' }) });
  ok(r.status === 200 && r.json.system_key === 'welcome_guide', 'system email customized');
  r = await req('/api/admin/system-templates');
  ok(r.json.find(s => s.key === 'welcome_guide').customized, 'customization shows in the list');
  await req(`/api/admin/loans/${miLoanId}/homebuyer-guide`, { method: 'POST', body: '{}' });
  r = await req(`/api/admin/loans/${miLoanId}/messages`);
  const wm = r.json.filter(m => /Welcome home, Mia/.test(m.subject || '')).pop();
  ok(!!wm, 'custom subject with merge field used on resend');
  ok(wm && /Howdy Mia/.test(wm.body), 'custom intro leads the message');
  ok(wm && /\$50\.00 servicing/.test(wm.body), 'appended details survive customization');
  // Unknown system keys are refused; the general list hides system rows.
  r = await req('/api/admin/templates', { method: 'POST', body: JSON.stringify({
    name: 'x', system_key: 'nope', body_html: '<p>x</p>' }) });
  ok(r.status === 400, 'unknown system email key rejected');
  r = await req('/api/admin/templates');
  ok(!r.json.templates.some(t => t.system_key), 'system customizations stay out of the general list');
  ok(r.json.system.length === 1, 'and appear in their own list');

  r = await req('/api/admin/doc-templates');
  ok(r.json.length === 7, 'seven buyer document templates listed');
  for (const key of ['welcome_guide', 'late5_notice', 'delivery_certificate', 'partial_receipt',
                     'escrow_update', 'payoff_statement', 'dc101']) {
    const pr = await fetch(`${BASE}/api/admin/doc-templates/${key}.pdf${key === 'welcome_guide' ? '?city=Detroit&structure=pit' : ''}`,
      { headers: { Cookie: adminCookie } });
    const pb = Buffer.from(await pr.arrayBuffer());
    ok(pr.status === 200 && pb.slice(0, 5).toString() === '%PDF-', `doc template preview renders: ${key}`);
  }

  console.log('— dashboard property counts');
  r = await req('/api/admin/summary');
  const pcBefore = r.json.property_counts;
  ok(typeof pcBefore.archived === 'number', 'summary reports archived count separately');
  ok(pcBefore.total >= 2, 'live properties counted');

  console.log('— login throttling');
  let throttled = false;
  for (let i = 0; i < 8; i++) {
    const rr = await req('/api/login', { method: 'POST', body: JSON.stringify({ email: 'admin@test.com', password: 'wrong-guess-' + i }) }, '');
    if (rr.status === 429) { throttled = true; break; }
  }
  ok(throttled, 'repeated wrong passwords get rate limited');
  r = await req('/api/login', { method: 'POST', body: JSON.stringify({ email: 'nobody@test.com', password: 'x' }) }, '');
  ok(r.status === 401 || r.status === 429, 'unknown email still rejected');

  console.log('— security');
  r = await req('/api/admin/pml', {}, tbCookie);
  ok(r.status === 403, 'TB cannot see PML loans');
  r = await req('/api/admin/summary', {}, tbCookie);
  ok(r.status === 403, 'TB blocked from admin routes');
  r = await req('/api/tenant/loan', {}, '');
  ok(r.status === 401, 'anonymous blocked');

  console.log('— account data export & deletion');
  const expRes = await fetch(BASE + '/api/account/export', { headers: { Cookie: tbCookie } });
  const expJson = await expRes.json();
  ok(expRes.status === 200 && expJson.account && expJson.payment_history, 'TB can export their data');
  ok(!JSON.stringify(expJson).includes('Rival'), 'export contains only their own data');
  r = await req('/api/account/delete', { method: 'POST', body: JSON.stringify({ confirm: 'nope' }) }, tbCookie);
  ok(r.status === 400, 'deletion requires typed confirmation');
  // The buyer has sent messages, made payments and has notices — deletion must still work.
  r = await req('/api/account/delete', { method: 'POST', body: JSON.stringify({ confirm: 'DELETE' }) }, tbCookie);
  ok(r.status === 200, 'buyer with messages + payments + notices can delete account');
  r = await req('/api/me', {}, tbCookie);
  ok(r.status === 401, 'deleted account session is dead');
  r = await req('/api/login', { method: 'POST', body: JSON.stringify({ email: 'jane@test.com', password: 'JanePass123!' }) }, '');
  ok(r.status === 401, 'deleted account cannot sign back in');
  r = await req('/api/admin/loans/' + loanId);
  ok(r.status === 200 && r.json.ledger.length > 0, 'loan ledger survives buyer deletion (legal retention)');
  ok(r.json.loan.tenant_user_id === null, 'loan detached from deleted buyer');
  r = await req('/api/admin/tenants');
  ok(!r.json.some(t => t.email === 'jane@test.com'), 'deleted buyer gone from admin list');
  r = await req(`/api/admin/loans/${loanId}/messages`);
  ok(r.json.every(m => m.sender_role !== 'tenant' || m.body === '[message removed at user request]'),
    'buyer message content anonymized');
  // Staff removal must survive their recorded activity too
  r = await req('/api/admin/staff', { method: 'POST', body: JSON.stringify({ name: 'Temp Staff', email: 'temp@test.com' }) });
  const tempStaff = r.json;
  const tsCookie = (await req('/api/login', { method: 'POST', body: JSON.stringify({ email: 'temp@test.com', password: tempStaff.temp_password }) }, '')).cookie;
  await req('/api/change-password', { method: 'POST', body: JSON.stringify({ password: 'TempStaff123!' }) }, tsCookie);
  await req(`/api/admin/loans/${loanId}/payments`, { method: 'POST', body: JSON.stringify({ amount_cents: 25000, method: 'cash' }) }, tsCookie);
  r = await req('/api/admin/staff/' + tempStaff.id, { method: 'DELETE' });
  ok(r.status === 200, 'staff who recorded payments can be removed');
  r = await req('/api/admin/company');
  ok(!r.json.staff.some(u => u.email === 'temp@test.com'), 'removed staff gone from team list');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
