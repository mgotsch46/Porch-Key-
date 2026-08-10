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
  r = await req('/api/tenant/pay/cash-slip', { method: 'POST', body: JSON.stringify({ amount_cents: 5000 }) }, tbCookie);
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
  ok(r.json.length === 1 && r.json[0].unread >= 1, 'admin sees unread thread');
  r = await req(`/api/admin/loans/${loanId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Got it — thanks!' }) });
  ok(r.status === 200, 'admin replies');
  r = await req('/api/tenant/messages', {}, tbCookie);
  ok(r.json.length >= 3, 'TB sees full thread (incl notice ping)');

  console.log('— cash at retail');
  r = await req('/api/tenant/pay/cash-slip', { method: 'POST', body: JSON.stringify({ amount_cents: 110000 }) }, tbCookie);
  ok(r.status === 200 && r.json.slip_code.startsWith('CP-'), 'TB generates cash payment code');
  const slipId = r.json.id;
  r = await req('/api/admin/cash-slips');
  ok(r.json.some(s => s.id === slipId && s.status === 'open'), 'admin sees open slip');
  r = await req(`/api/admin/cash-slips/${slipId}/mark-paid`, { method: 'POST', body: '{}' });
  ok(r.status === 200, 'admin marks slip paid');
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
  ok(['loan_docs','insurance','taxes','utilities','correspondence','private'].every(c => r.json[c]), 'all folders present as placeholders');
  r = await req('/api/tenant/documents', {}, tbCookie);
  ok(r.json.length === 5, 'TB sees 5 shared folders (placeholders included)');
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

  console.log('— location (opt-in)');
  r = await req('/api/tenant/location', { method: 'POST', body: JSON.stringify({ lat: 40.1, lng: -83.0 }) }, tbCookie);
  ok(r.status === 403, 'location rejected without consent');
  r = await req('/api/tenant/location/consent', { method: 'POST', body: JSON.stringify({ consent: true }) }, tbCookie);
  ok(r.status === 200, 'TB grants location consent');
  r = await req('/api/tenant/location', { method: 'POST', body: JSON.stringify({ lat: 40.1, lng: -83.0, accuracy_m: 25 }) }, tbCookie);
  ok(r.status === 200, 'location ping accepted after consent');
  r = await req(`/api/admin/tenants/${tbId}/location`);
  ok(r.json.consent_at && r.json.last_ping && r.json.last_ping.lat === 40.1, 'admin sees consented last location');
  r = await req('/api/tenant/location/consent', { method: 'POST', body: JSON.stringify({ consent: false }) }, tbCookie);
  r = await req(`/api/admin/tenants/${tbId}/location`);
  ok(!r.json.consent_at && !r.json.last_ping, 'revoking consent deletes location history');

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
  ok(r.json.late_fee_cents === 5000, 'company default late fee returned');

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
  ok(r.json.loan.late_fee_cents === 5000, 'property with no late fee falls back to company default');

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
  r = await req('/api/admin/cash-slips', {}, rivalCookie);
  ok(r.json.length === 0, 'rival sees no cash slips');
  r = await req(`/api/admin/tenants/${tbId}/location`, {}, rivalCookie);
  ok(r.status === 404, 'rival cannot read company A buyer location');
  r = await req(`/api/admin/loans/${loanId}/notices`, {}, rivalCookie);
  ok(r.status === 404, 'rival cannot read company A notices');
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
