// Loan Servicing App — Express server
// Tenant buyer app served at "/", admin portal at "/admin".
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, get, all, run, hashPassword, verifyPassword } = require('./db');
const loanEngine = require('./loan');
const pay = require('./payments');
const ai = require('./ai');
const sms = require('./sms');
const reports = require('./reports');
const tpl = require('./templates');
const addr = require('./address');
const notify = require('./notify');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- auth ----------
function secret() {
  let s = get("SELECT value FROM settings WHERE key='secret'");
  if (!s) {
    const v = crypto.randomBytes(32).toString('hex');
    run("INSERT INTO settings (key,value) VALUES ('secret',?)", v);
    return v;
  }
  return s.value;
}
const SECRET = process.env.APP_SECRET || secret();

function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verifyToken(token) {
  if (!token) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
  if (payload.exp < Date.now()) return null;
  return payload;
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
// Current published version of the buyer Terms + Privacy Policy. Bump this string
// whenever the legal text changes and every buyer is re-prompted to accept.
const TERMS_VERSION = process.env.TERMS_VERSION || '2026-08-09';

// roles: 'super_admin' (platform), 'owner'/'admin' (a servicing company), 'tenant' (buyer)
const ADMIN_ROLES = ['owner', 'admin'];
function auth(kind) {
  return (req, res, next) => {
    const payload = verifyToken(getCookie(req, 'session'));
    if (!payload) return res.status(401).json({ error: 'Not signed in' });
    const user = get(`SELECT id, company_id, email, role, name, phone, must_change_password,
      terms_accepted_at, terms_version, location_consent_at, deleted_at, archived_at
      FROM users WHERE id=?`, payload.uid);
    if (!user || user.deleted_at) return res.status(401).json({ error: 'Not signed in' });
    if (user.archived_at) return res.status(403).json({ error: 'This account is archived. Contact your servicer.' });
    if (kind === 'admin' && !ADMIN_ROLES.includes(user.role)) return res.status(403).json({ error: 'Forbidden' });
    if (kind === 'owner' && user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
    if (kind === 'super' && user.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });
    if (kind === 'tenant' && user.role !== 'tenant') return res.status(403).json({ error: 'Forbidden' });
    if (ADMIN_ROLES.includes(user.role)) {
      const co = get('SELECT status FROM companies WHERE id=?', user.company_id);
      if (co && co.status === 'suspended') return res.status(403).json({ error: 'This account is suspended.' });
    }
    req.user = user;
    req.companyId = user.company_id;
    next();
  };
}
const adminOnly = auth('admin');
const ownerOnly = auth('owner');
const superOnly = auth('super');
const tenantOnly = auth('tenant');
const anyUser = auth(null);

// Buyers must accept Terms + Privacy before any loan data, messaging, or payment route.
function requireTerms(req, res, next) {
  if (req.user.role === 'tenant' && (!req.user.terms_accepted_at || req.user.terms_version !== TERMS_VERSION)) {
    return res.status(451).json({ error: 'Terms acceptance required', terms_version: TERMS_VERSION });
  }
  next();
}
const tenantReady = [tenantOnly, requireTerms];

// Every admin read/write is scoped to the signed-in user's company. These helpers make
// that the default path so a missing WHERE clause can't leak another company's data.
function ownedLoan(req, id) {
  return get('SELECT * FROM loans WHERE id=? AND company_id=?', id, req.companyId);
}
function ownedProperty(req, id) {
  return get('SELECT * FROM properties WHERE id=? AND company_id=?', id, req.companyId);
}

// ---------- stripe webhook needs raw body, mount before json parser ----------
app.post('/api/stripe/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const payload = req.body.toString('utf8');
  if (whSecret && !pay.verifyStripeSignature(payload, req.headers['stripe-signature'], whSecret)) {
    return res.status(400).send('Bad signature');
  }
  try {
    const event = JSON.parse(payload);
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      if (s.payment_status === 'paid' && s.metadata && s.metadata.loan_id) {
        postStripePayment(s);
      }
    }
    res.json({ received: true });
  } catch (e) {
    res.status(400).send('Bad payload');
  }
});

// PayNearMe webhook — posts cash payments automatically once the store confirms.
app.post('/api/paynearme/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const payload = req.body.toString('utf8');
  if (!pay.verifyPnmSignature(payload, req.headers['x-paynearme-signature'], process.env.PNM_WEBHOOK_SECRET)) {
    return res.status(400).send('Bad signature');
  }
  try {
    // PayNearMe posts form-encoded or JSON depending on config; handle both.
    let d;
    try { d = JSON.parse(payload); } catch { d = Object.fromEntries(new URLSearchParams(payload)); }
    const code = d.site_order_identifier || d.payment_identifier || d.order_identifier;
    const status = (d.payment_status || d.status || '').toLowerCase();
    const slip = code ? get('SELECT * FROM cash_slips WHERE slip_code=?', code) : null;
    if (slip && slip.status === 'open' && (status === 'paid' || status === 'settled' || status === 'complete')) {
      postPayment(slip.loan_id, slip.amount_cents, 'cash_retail', today(),
        `pnm:${code}`, `Cash payment at retailer — ${code}`, null);
      run("UPDATE cash_slips SET status='paid', paid_at=datetime('now') WHERE id=?", slip.id);
      console.log(`PayNearMe cash payment posted for slip ${code}`);
    }
    res.json({ received: true });
  } catch (e) { res.status(400).send('Bad payload'); }
});

app.use(express.json({ limit: '60mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const today = () => new Date().toISOString().slice(0, 10);
const money = c => (c / 100).toFixed(2);

// ---------- servicing helpers ----------
function assessRecurringCharges(loan) {
  const charges = all('SELECT * FROM charges WHERE loan_id=? AND recurring=1 AND active=1', loan.id);
  for (const ch of charges) {
    const start = ch.start_date || loan.first_payment_date;
    const end = ch.end_date && ch.end_date < today() ? ch.end_date : today();
    let d = new Date(start + 'T00:00:00Z');
    const now = new Date(end + 'T00:00:00Z');
    while (d <= now) {
      const period = d.toISOString().slice(0, 7); // YYYY-MM
      const tag = `charge:${ch.id}:${period}`;
      const exists = get('SELECT id FROM ledger WHERE loan_id=? AND memo=?', loan.id, tag);
      if (!exists) {
        run(`INSERT INTO ledger (loan_id, entry_date, type, amount_cents, memo)
             VALUES (?,?,?,?,?)`, loan.id, d.toISOString().slice(0, 10), 'fee', -ch.amount_cents, tag);
        run('UPDATE loans SET fees_due_cents = fees_due_cents + ? WHERE id=?', ch.amount_cents, loan.id);
      }
      d = loanEngine.addMonthsUTC(d, 1);
    }
  }
  return get('SELECT * FROM loans WHERE id=?', loan.id);
}

function postPayment(loanId, amountCents, method, entryDate, externalId, memo, createdBy, feeCents) {
  let loan = get('SELECT * FROM loans WHERE id=?', loanId);
  if (!loan) throw new Error('Loan not found');
  loan = assessRecurringCharges(loan);
  if (externalId && get('SELECT id FROM ledger WHERE external_id=?', externalId)) {
    return { duplicate: true };
  }
  const alloc = loanEngine.allocatePayment(loan, amountCents, entryDate);
  const newPrincipal = loan.principal_balance_cents - alloc.to_principal_cents;
  const newEscrow = loan.escrow_balance_cents + alloc.to_escrow_cents + alloc.unapplied_cents;
  const newFees = loan.fees_due_cents - alloc.to_fees_cents;
  const newInterestDue = alloc.interest_shortfall_cents;
  run(`INSERT INTO ledger (loan_id, entry_date, type, method, amount_cents, to_interest_cents,
        to_principal_cents, to_escrow_cents, to_fees_cents, principal_balance_after_cents, memo, external_id, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    loanId, entryDate, 'payment', method, amountCents, alloc.to_interest_cents,
    alloc.to_principal_cents, alloc.to_escrow_cents + alloc.unapplied_cents, alloc.to_fees_cents,
    newPrincipal, memo || null, externalId || null, createdBy || null);
  if (feeCents) run('UPDATE ledger SET fee_cents=? WHERE id=(SELECT MAX(id) FROM ledger WHERE loan_id=?)', feeCents, loanId);
  if (loan.tenant_user_id) {
    notify.notify(loan.tenant_user_id, {
      kind: 'payment_received', title: 'Payment received',
      body: `We applied $${(amountCents / 100).toFixed(2)} to your loan. Balance is now $${(newPrincipal / 100).toFixed(2)}.`,
      url: '/?tab=activity',
    }).catch(() => {});
  }
  run(`UPDATE loans SET principal_balance_cents=?, escrow_balance_cents=?, fees_due_cents=?,
        interest_due_cents=?, status=CASE WHEN ?<=0 THEN 'paid_off' ELSE status END WHERE id=?`,
    newPrincipal, newEscrow, newFees, newInterestDue, newPrincipal, loanId);
  return { alloc, newPrincipal };
}

function postStripePayment(session) {
  const loanId = Number(session.metadata.loan_id);
  const fee = Number((session.metadata && session.metadata.fee_cents) || 0);
  const amount = Number(session.metadata.amount_cents || ((session.amount_total || 0) - fee));
  const pmType = (session.payment_method_types && session.payment_method_types[0]) || 'card';
  const method = pmType === 'cashapp' ? 'stripe_cashapp' : pmType === 'us_bank_account' ? 'stripe_ach' : 'stripe_card';
  return postPayment(loanId, amount, method, today(), `stripe:${session.id}`, 'Online payment', null, fee);
}

// ---------- automated late / legal notices ----------
// A payment only counts as "confirmed" once it's on the ledger: admin-recorded payments,
// Stripe webhook/confirm postings, or cash slips the admin marked paid. The sweep sends a
// late notice once a payment is past due + grace with nothing confirmed for that period,
// and escalates to a legal notice after LEGAL_NOTICE_DAYS past due. Read receipts are
// recorded when the buyer opens the notice in the app.
const LEGAL_NOTICE_DAYS = Number(process.env.LEGAL_NOTICE_DAYS || 15);

function noticeTemplates(loan, property, tenant, amountDueCents, dueDate, daysPast) {
  const amt = '$' + (amountDueCents / 100).toFixed(2);
  const addr = property ? property.address : 'your property';
  return {
    late_notice: {
      subject: `Late Payment Notice — ${addr}`,
      body: `Dear ${tenant.name},\n\nOur records show that your payment of ${amt} due ${dueDate} for ${addr} has not been received and is now ${daysPast} days past due (beyond the ${loan.grace_days}-day grace period).${loan.late_fee_cents ? ` A late fee of $${(loan.late_fee_cents/100).toFixed(2)} may apply per your agreement.` : ''}\n\nPlease make your payment through the app (card, bank transfer, Cash App Pay, or cash at a participating retailer) or contact us immediately to discuss your account.\n\nIf you have already sent payment, please disregard this notice and message us so we can confirm receipt.\n\n— Loan Servicing`,
    },
    legal_notice: {
      subject: `IMPORTANT: Notice of Default — ${addr}`,
      body: `Dear ${tenant.name},\n\nThis is a formal notice that your account for ${addr} is seriously past due. The payment of ${amt} due ${dueDate} remains unpaid ${daysPast} days after its due date, and prior notices have not resolved the delinquency.\n\nUnder the terms of your agreement, continued non-payment may result in default proceedings, including forfeiture/eviction action and additional fees and costs as permitted by law.\n\nTo avoid further action, pay the full past-due amount immediately through the app or contact us today to make arrangements.\n\nThis notice is provided in addition to, and does not replace, any notices required to be delivered by other means under your agreement or applicable law.\n\n— Loan Servicing`,
    },
  };
}

function runNoticeSweep() {
  const loans = all("SELECT * FROM loans WHERE status='active' AND tenant_user_id IS NOT NULL");
  const nowDate = new Date(today() + 'T00:00:00Z');
  for (let loan of loans) {
    try {
      loan = assessRecurringCharges(loan);
      const ledger = all('SELECT * FROM ledger WHERE loan_id=?', loan.id);
      const status = loanEngine.loanStatus(loan, ledger, today());
      if (!status.is_past_due) continue;
      // earliest unmet payment period
      const idx = status.payments_made_equiv; // 0-based count of covered payments
      const first = new Date(loan.first_payment_date + 'T00:00:00Z');
      const dueDateObj = loanEngine.addMonthsUTC(first, idx);
      const dueDate = dueDateObj.toISOString().slice(0, 10);
      const period = dueDate.slice(0, 7);
      const daysPast = Math.floor((nowDate - dueDateObj) / 86400000);
      if (daysPast <= loan.grace_days) continue;
      const property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
      const tenant = get('SELECT * FROM users WHERE id=?', loan.tenant_user_id);
      const noticeSet = noticeTemplates(loan, property, tenant, status.owed_now_cents, dueDate, daysPast);
      const sendNotice = (type) => {
        if (get('SELECT id FROM notices WHERE loan_id=? AND type=? AND period=?', loan.id, type, period)) return;
        const t = noticeSet[type];
        const co = get('SELECT * FROM companies WHERE id=?', loan.company_id);
        const noticeHtml = tpl.brandedShell({
          company: co, subject: t.subject,
          bodyHtml: t.body.split('\n\n').map(par => `<p>${tpl.escapeHtml(par)}</p>`).join(''),
          baseUrl: process.env.BASE_URL || '',
        });
        run('INSERT INTO notices (loan_id, type, period, subject, body, body_html) VALUES (?,?,?,?,?,?)',
          loan.id, type, period, t.subject, t.body, noticeHtml);
        // also drop it into the message thread so the buyer sees it immediately
        run('INSERT INTO messages (loan_id, sender_user_id, body, read_by_admin) VALUES (?,?,?,1)',
          loan.id, get("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') ORDER BY id LIMIT 1", loan.company_id).id,
          `📄 ${t.subject} — open the Notices section on your Home screen to read this important notice.`);
        if (loan.tenant_user_id) {
          notify.notify(loan.tenant_user_id, { kind: 'notice', title: t.subject,
            body: 'Open the app to read this notice.', url: '/', dedupeKey: `notice:${type}:${period}:${loan.id}` })
            .catch(() => {});
        }
        console.log(`Sent ${type} for loan ${loan.id} period ${period}`);
      };
      sendNotice('late_notice');
      if (daysPast > LEGAL_NOTICE_DAYS) sendNotice('legal_notice');
    } catch (e) { console.error('Notice sweep error for loan', loan.id, e.message); }
  }
}
setInterval(runNoticeSweep, 60 * 60 * 1000); // hourly
setTimeout(runNoticeSweep, 5000);            // shortly after boot

function loanFull(loan) {
  loan = assessRecurringCharges(loan);
  const ledger = all('SELECT * FROM ledger WHERE loan_id=? ORDER BY entry_date, id', loan.id);
  const status = loanEngine.loanStatus(loan, ledger, today());
  const property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
  const tenant = loan.tenant_user_id ? get('SELECT id,name,email,phone FROM users WHERE id=?', loan.tenant_user_id) : null;
  const charges = all('SELECT * FROM charges WHERE loan_id=? AND active=1', loan.id);
  return { loan, ledger, status, property, tenant, charges };
}

// ---------- login throttling ----------
// Counts failures per email+IP. Short lockout that grows with repeated failures, so a
// script guessing passwords gets nowhere while a person who fat-fingers theirs waits seconds.
const loginFails = new Map();
function throttleKey(req, email) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  return `${ip}|${String(email || '').toLowerCase()}`;
}
function throttleCheck(key) {
  const rec = loginFails.get(key);
  if (!rec) return null;
  if (Date.now() > rec.until) { loginFails.delete(key); return null; }
  if (rec.count < 5) return null;
  return Math.ceil((rec.until - Date.now()) / 1000);
}
function throttleFail(key) {
  const rec = loginFails.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  // 5 strikes, then 30s, 1m, 2m, 4m… capped at 15 minutes.
  const backoff = Math.min(30 * Math.pow(2, Math.max(0, rec.count - 5)), 900);
  rec.until = Date.now() + backoff * 1000;
  loginFails.set(key, rec);
}
function throttleClear(key) { loginFails.delete(key); }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginFails) if (now > v.until + 3600000) loginFails.delete(k);
}, 600000);

// ---------- auth routes ----------
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const key = throttleKey(req, email);
  const wait = throttleCheck(key);
  if (wait) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.` });
  }
  const user = get('SELECT * FROM users WHERE email=? AND deleted_at IS NULL',
    String(email || '').toLowerCase().trim());
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    throttleFail(key);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  throttleClear(key);
  if (user.archived_at) return res.status(403).json({ error: 'This account is archived. Contact your servicer.' });
  const token = sign({ uid: user.id, exp: Date.now() + 30 * 86400000 });
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; Max-Age=${30 * 86400}; SameSite=Lax`);
  res.json({ id: user.id, name: user.name, role: user.role, email: user.email, must_change_password: !!user.must_change_password });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', anyUser, (req, res) => res.json(req.user));
app.post('/api/change-password', anyUser, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  run('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', hashPassword(password), req.user.id);
  run("UPDATE invitations SET status='accepted', accepted_at=datetime('now') WHERE user_id=? AND status<>'accepted'", req.user.id);
  res.json({ ok: true });
});

// ---------- admin: summary ----------
app.get('/api/admin/summary', adminOnly, (req, res) => {
  const loans = all("SELECT * FROM loans WHERE status='active' AND company_id=?", req.companyId);
  let totalBalance = 0, pastDue = 0, owedNow = 0;
  const loanCards = loans.map(l => {
    const f = loanFull(l);
    totalBalance += f.loan.principal_balance_cents;
    if (f.status.is_past_due) { pastDue++; owedNow += f.status.owed_now_cents; }
    return {
      id: l.id, address: f.property ? f.property.address : '', tenant: f.tenant ? f.tenant.name : '(unassigned)',
      balance_cents: f.loan.principal_balance_cents, owed_now_cents: f.status.owed_now_cents,
      next_due_date: f.status.next_due_date, is_past_due: f.status.is_past_due, payment_cents: l.payment_cents + l.escrow_cents,
    };
  });
  // Money going OUT to private lenders, so the dashboard shows both sides.
  const pmlRows = all(`SELECT pl.*, p.address FROM pml_loans pl
    LEFT JOIN properties p ON p.id=pl.property_id
    WHERE pl.company_id=? AND pl.status='active' ORDER BY pl.id DESC`, req.companyId);
  const pmlCards = pmlRows.map(pl => ({
    id: pl.id, lender_name: pl.lender_name, address: pl.address || '',
    balance_cents: pl.principal_balance_cents, payment_cents: pl.payment_cents,
    rate_bps: pl.interest_rate_bps, lien_position: pl.lien_position,
    payment_type: pl.payment_type, autopay_enabled: !!pl.autopay_enabled,
    next_due_date: loanEngine.nextDueDate(pl, today()),
    balloon_date: pl.balloon_date,
  }));
  const pmlTotalBalance = pmlCards.reduce((t, x) => t + x.balance_cents, 0);
  const pmlTotalMonthly = pmlCards.reduce((t, x) => t + x.payment_cents, 0);
  const tbTotalMonthly = loans.reduce((t, l) => t + l.payment_cents + l.escrow_cents, 0);

  const unreadMsgs = get(`SELECT COUNT(*) c FROM messages m JOIN loans l ON l.id=m.loan_id
    WHERE m.read_by_admin=0 AND l.company_id=?`, req.companyId).c;
  const unassigned = get("SELECT COUNT(*) c FROM expenses WHERE status='unassigned' AND company_id=?", req.companyId).c;
  const company = get('SELECT id, name FROM companies WHERE id=?', req.companyId);
  res.json({
    company: { ...company, setup_complete: !!get('SELECT setup_complete FROM companies WHERE id=?', req.companyId).setup_complete },
    user: { name: req.user.name, role: req.user.role },
    active_loans: loans.length, total_balance_cents: totalBalance, past_due_count: pastDue,
    owed_now_cents: owedNow, unread_messages: unreadMsgs, unassigned_expenses: unassigned,
    loans: loanCards,
    pml_loans: pmlCards,
    property_counts: (() => {
      const rows = all(`SELECT COALESCE(phase,'acquired') phase, COUNT(*) c FROM properties
        WHERE company_id=? GROUP BY 1`, req.companyId);
      const by = {}; let total = 0;
      for (const r of rows) { by[r.phase] = r.c; total += r.c; }
      return { total, by_phase: by,
        owned: total - (by.sold || 0) - (by.paid_off || 0),
        sold: (by.sold || 0) + (by.paid_off || 0) };
    })(),
    income: (() => {
      const y = today().slice(0, 4);
      const ytd = reports.profitAndLoss(req.companyId, `${y}-01-01`, today());
      const life = reports.profitAndLoss(req.companyId, null, null);
      return {
        ytd_gross_cents: ytd.revenue.total_cents,
        ytd_expenses_cents: ytd.expenses.total_cents,
        ytd_net_cents: ytd.net_operating_income_cents,
        lifetime_gross_cents: life.revenue.total_cents,
        lifetime_net_cents: life.net_operating_income_cents,
        year: y,
      };
    })(),
    pml_total_balance_cents: pmlTotalBalance,
    pml_total_monthly_cents: pmlTotalMonthly,
    tb_total_monthly_cents: tbTotalMonthly,
    monthly_spread_cents: tbTotalMonthly - pmlTotalMonthly,
    properties_in_progress: all(`SELECT id, address, phase FROM properties
      WHERE company_id=? AND COALESCE(phase,'acquired') NOT IN ('sold','paid_off') ORDER BY id DESC`, req.companyId),
    integrations: { stripe: pay.stripeEnabled(), ai: ai.aiEnabled(), paynearme: pay.pnmEnabled(), sms: sms.smsEnabled() },
    pending_invitations: get("SELECT COUNT(*) c FROM invitations WHERE company_id=? AND status IN ('pending','failed')", req.companyId).c,
  });
});

// ---------- company & staff management ----------
// Only contact prefill lives at the company level. Late fee, grace period and the
// payment date are set per property, because they come out of that property's contract.
app.get('/api/admin/defaults', adminOnly, (req, res) => {
  const c = get('SELECT * FROM companies WHERE id=?', req.companyId);
  res.json({
    buyer_email: c.default_buyer_email || '',
    buyer_phone: c.default_buyer_phone || '',
    owner_name: c.mgmt_company_name || c.name || '',
    mgmt_company_name: c.mgmt_company_name || '',
    rep_name: c.rep_name || '', rep_phone: c.rep_phone || '',
    mailing_address: c.mailing_address || '', mailing_city: c.mailing_city || '',
    mailing_state: c.mailing_state || '', mailing_zip: c.mailing_zip || '',
    owner_types: OWNER_TYPES,
  });
});
app.get('/api/admin/company', adminOnly, (req, res) => {
  const company = get('SELECT * FROM companies WHERE id=?', req.companyId);
  const staff = all(`SELECT id, name, email, role, archived_at, created_at FROM users
    WHERE company_id=? AND role IN ('owner','admin') AND deleted_at IS NULL ORDER BY id`, req.companyId);
  res.json({ company, staff, is_owner: req.user.role === 'owner' });
});
app.put('/api/admin/company', ownerOnly, (req, res) => {
  const c = get('SELECT * FROM companies WHERE id=?', req.companyId);
  run('UPDATE companies SET name=?, contact_email=?, contact_phone=? WHERE id=?',
    req.body.name || c.name, req.body.contact_email ?? c.contact_email,
    req.body.contact_phone !== undefined ? addr.formatPhone(req.body.contact_phone) : c.contact_phone, c.id);
  res.json(get('SELECT * FROM companies WHERE id=?', c.id));
});
app.post('/api/admin/staff', ownerOnly, (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  if (get('SELECT id FROM users WHERE email=?', email.toLowerCase().trim()))
    return res.status(400).json({ error: 'That email is already in use' });
  const temp = 'ST-' + crypto.randomInt(100000, 999999) + '!';
  const r = run(`INSERT INTO users (company_id, email, password_hash, role, name, must_change_password)
    VALUES (?,?,?,?,?,1)`, req.companyId, email.toLowerCase().trim(), hashPassword(temp), 'admin', name);
  res.json({ id: r.lastInsertRowid, name, email, temp_password: temp });
});
app.delete('/api/admin/staff/:id', ownerOnly, (req, res, next) => {
  const u = get("SELECT * FROM users WHERE id=? AND company_id=? AND role='admin' AND deleted_at IS NULL",
    req.params.id, req.companyId);
  if (!u) return res.status(404).json({ error: 'Staff member not found' });
  try { eraseUser(u.id, 'admin'); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---------- first-run setup wizard ----------
app.get('/api/admin/setup-state', adminOnly, (req, res) => {
  const c = get('SELECT * FROM companies WHERE id=?', req.companyId);
  // Belt and braces: if this company is clearly already in use — real name, and the
  // owner has set their own password — treat setup as done even if the flag went
  // missing. Nobody should be walked through setup twice.
  if (!c.setup_complete && c.name && c.name !== 'My Company' && !req.user.must_change_password) {
    run('UPDATE companies SET setup_complete=1 WHERE id=?', c.id);
    c.setup_complete = 1;
  }
  res.json({
    setup_complete: !!c.setup_complete,
    must_change_password: !!req.user.must_change_password,
    company: { name: c.name, contact_email: c.contact_email, contact_phone: c.contact_phone,
      logo_path: c.logo_path, pass_fees_to_buyer: c.pass_fees_to_buyer,
      mgmt_company_name: c.mgmt_company_name, rep_name: c.rep_name, rep_phone: c.rep_phone,
      mailing_address: c.mailing_address, mailing_city: c.mailing_city,
      mailing_state: c.mailing_state, mailing_zip: c.mailing_zip,
      fee_label: c.fee_label },
    user: { name: req.user.name, phone: req.user.phone, email: req.user.email },
  });
});
app.post('/api/admin/setup-skip', adminOnly, (req, res) => {
  run('UPDATE companies SET setup_complete=1 WHERE id=?', req.companyId);
  res.json({ ok: true });
});

app.post('/api/admin/setup', adminOnly, (req, res, next) => {
  const b = req.body || {};
  try {
    if (b.password) {
      if (b.password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      run('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', hashPassword(b.password), req.user.id);
    }
    if (b.name || b.phone !== undefined) {
      run('UPDATE users SET name=COALESCE(?,name), phone=? WHERE id=?',
        b.name || null, b.phone !== undefined ? addr.formatPhone(b.phone) : req.user.phone, req.user.id);
    }
    if (b.logo_base64 && b.logo_filename) {
      const stored = 'logo-' + crypto.randomUUID() + path.extname(b.logo_filename);
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), Buffer.from(b.logo_base64, 'base64'));
      run('UPDATE companies SET logo_path=? WHERE id=?', stored, req.companyId);
    }
    const c = get('SELECT * FROM companies WHERE id=?', req.companyId);
    run(`UPDATE companies SET name=?, contact_email=?, contact_phone=?,
          pass_fees_to_buyer=?, fee_label=?,
          mgmt_company_name=?, rep_name=?, rep_phone=?,
          mailing_address=?, mailing_city=?, mailing_state=?, mailing_zip=? WHERE id=?`,
      b.company_name || c.name, b.contact_email ?? c.contact_email, b.contact_phone ?? c.contact_phone,
      b.pass_fees_to_buyer === undefined ? c.pass_fees_to_buyer : (b.pass_fees_to_buyer ? 1 : 0),
      b.fee_label || c.fee_label,
      b.mgmt_company_name ?? c.mgmt_company_name, b.rep_name ?? c.rep_name,
      b.rep_phone !== undefined ? addr.formatPhone(b.rep_phone) : c.rep_phone,
      b.mailing_address ?? c.mailing_address, b.mailing_city ?? c.mailing_city,
      b.mailing_state ?? c.mailing_state, b.mailing_zip ?? c.mailing_zip, req.companyId);
    if (b.default_buyer_email !== undefined || b.default_buyer_phone !== undefined) {
      run('UPDATE companies SET default_buyer_email=?, default_buyer_phone=? WHERE id=?',
        b.default_buyer_email ?? c.default_buyer_email, b.default_buyer_phone ?? c.default_buyer_phone, req.companyId);
    }
    if (b.finish) run('UPDATE companies SET setup_complete=1 WHERE id=?', req.companyId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.get('/api/company-logo/:companyId', (req, res) => {
  const c = get('SELECT logo_path FROM companies WHERE id=?', req.params.companyId);
  if (!c || !c.logo_path) return res.status(404).end();
  const f = path.join(UPLOAD_DIR, c.logo_path);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
});

// ---------- admin financial sync: link bank / credit card accounts ----------
app.get('/api/admin/linked-accounts', adminOnly, (req, res) => {
  res.json({
    stripe: pay.stripeEnabled(),
    accounts: all(`SELECT id, institution_name, display_name, last4, category, status, last_synced_at
      FROM linked_accounts WHERE company_id=? ORDER BY id`, req.companyId),
  });
});
app.post('/api/admin/linked-accounts/session', adminOnly, async (req, res, next) => {
  if (!pay.stripeEnabled()) return res.status(400).json({ error: 'Connect Stripe first — set STRIPE_SECRET_KEY.' });
  try {
    const customerId = await customerFor(req.user);
    const session = await pay.createFinancialConnectionsSession({ customerId, baseUrl: baseUrlOf(req) });
    res.json({ client_secret: session.client_secret, session_id: session.id });
  } catch (e) { next(e); }
});
app.post('/api/admin/linked-accounts/finish', adminOnly, async (req, res, next) => {
  try {
    const accounts = await pay.listFinancialAccounts(req.body.session_id);
    let added = 0;
    for (const a of accounts) {
      if (get('SELECT id FROM linked_accounts WHERE stripe_account_id=?', a.id)) continue;
      run(`INSERT INTO linked_accounts (company_id, stripe_account_id, institution_name,
            display_name, last4, category) VALUES (?,?,?,?,?,?)`,
        req.companyId, a.id, a.institution_name || null, a.display_name || null,
        a.last4 || null, a.category || a.subcategory || null);
      added++;
    }
    res.json({ added });
  } catch (e) { next(e); }
});
app.post('/api/admin/linked-accounts/:id/sync', adminOnly, async (req, res, next) => {
  const acct = get('SELECT * FROM linked_accounts WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  try {
    try { await pay.refreshAccountTransactions(acct.stripe_account_id); } catch {}
    const txns = await pay.listAccountTransactions(acct.stripe_account_id, 200);
    let imported = 0;
    for (const t of txns) {
      if (t.amount >= 0) continue;                                   // money in, not an expense
      const ext = `fc:${t.id}`;
      if (get('SELECT id FROM expenses WHERE external_id=?', ext)) continue;
      run(`INSERT INTO expenses (company_id, property_id, txn_date, description, amount_cents,
            category, status, linked_account_id, external_id) VALUES (?,?,?,?,?,?,?,?,?)`,
        req.companyId, null,
        new Date((t.transacted_at || t.posted_at || Date.now()/1000) * 1000).toISOString().slice(0,10),
        t.description || '(no description)', Math.abs(t.amount), null, 'unassigned', acct.id, ext);
      imported++;
    }
    run("UPDATE linked_accounts SET last_synced_at=datetime('now') WHERE id=?", acct.id);
    res.json({ imported });
  } catch (e) { next(e); }
});
app.delete('/api/admin/linked-accounts/:id', adminOnly, (req, res) => {
  const acct = get('SELECT * FROM linked_accounts WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  run("UPDATE linked_accounts SET status='disconnected' WHERE id=?", acct.id);
  res.json({ ok: true });
});

// ---------- company signup (new servicing company self-onboards) ----------
app.post('/api/signup', (req, res) => {
  if (process.env.SIGNUPS_OPEN === 'false') return res.status(403).json({ error: 'Signups are closed' });
  const { company_name, name, email, password } = req.body || {};
  if (!company_name || !name || !email || !password)
    return res.status(400).json({ error: 'Company name, your name, email, and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const em = String(email).toLowerCase().trim();
  if (get('SELECT id FROM users WHERE email=?', em)) return res.status(400).json({ error: 'That email is already registered' });
  const co = run('INSERT INTO companies (name, contact_email) VALUES (?,?)', company_name, em);
  const u = run(`INSERT INTO users (company_id, email, password_hash, role, name) VALUES (?,?,?,?,?)`,
    co.lastInsertRowid, em, hashPassword(password), 'owner', name);
  const token = sign({ uid: u.lastInsertRowid, exp: Date.now() + 30 * 86400000 });
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; Max-Age=${30 * 86400}; SameSite=Lax`);
  res.json({ id: u.lastInsertRowid, name, role: 'owner', company_id: co.lastInsertRowid });
});

// ---------- platform super admin ----------
app.get('/api/super/companies', superOnly, (req, res) => {
  res.json(all(`SELECT c.*,
    (SELECT COUNT(*) FROM loans WHERE company_id=c.id) AS loan_count,
    (SELECT COUNT(*) FROM users WHERE company_id=c.id AND role='tenant') AS buyer_count,
    (SELECT email FROM users WHERE company_id=c.id AND role='owner' ORDER BY id LIMIT 1) AS owner_email
    FROM companies c ORDER BY c.id DESC`));
});
app.put('/api/super/companies/:id', superOnly, (req, res) => {
  const status = req.body.status;
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  run('UPDATE companies SET status=? WHERE id=?', status, req.params.id);
  res.json({ ok: true });
});

// ---------- admin: properties ----------
app.get('/api/admin/properties', adminOnly, (req, res) => {
  const props = all('SELECT * FROM properties WHERE company_id=? ORDER BY id DESC', req.companyId);
  for (const p of props) {
    p.expense_total_cents = get("SELECT COALESCE(SUM(amount_cents),0) s FROM expenses WHERE property_id=? AND status='assigned'", p.id).s;
    p.cost_basis_cents = propertyBasis(p.id).total_cents;
    p.all_in_cents = p.cost_basis_cents + p.expense_total_cents;
    const l = get("SELECT id, sale_price_cents, principal_balance_cents FROM loans WHERE property_id=? AND status='active' ORDER BY id DESC LIMIT 1", p.id);
    p.loan = l || null;
  }
  res.json(props);
});
app.post('/api/admin/properties', adminOnly, (req, res) => {
  const { address, city, state, zip, trust_name, trustee, notes } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Address required' });
  const r = run(`INSERT INTO properties (company_id, address, city, state, zip, trust_name, trustee, notes, lat, lng, county)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    req.companyId, address, city || null, state || null, zip || null, trust_name || null,
    trustee || null, notes || null, req.body.lat || null, req.body.lng || null, req.body.county || null);
  res.json(get('SELECT * FROM properties WHERE id=?', r.lastInsertRowid));
});
app.put('/api/admin/properties/:id', adminOnly, (req, res) => {
  const p = ownedProperty(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const b = { ...p, ...req.body };
  run('UPDATE properties SET address=?, city=?, state=?, zip=?, trust_name=?, trustee=?, notes=? WHERE id=?',
    b.address, b.city, b.state, b.zip, b.trust_name, b.trustee, b.notes, p.id);
  res.json(get('SELECT * FROM properties WHERE id=?', p.id));
});

// ---------- reports: P&L, balance sheet, returns ----------
app.get('/api/admin/reports/pl', adminOnly, (req, res) => {
  res.json(reports.profitAndLoss(req.companyId, req.query.from || null, req.query.to || null));
});
app.get('/api/admin/reports/balance-sheet', adminOnly, (req, res) => {
  res.json(reports.balanceSheet(req.companyId, req.query.as_of || null));
});
app.get('/api/admin/reports/returns', adminOnly, (req, res) => {
  res.json(reports.portfolioReturns(req.companyId));
});
app.get('/api/admin/reports/returns/:propertyId', adminOnly, (req, res) => {
  const r = reports.propertyReturns(req.companyId, req.params.propertyId);
  if (!r) return res.status(404).json({ error: 'Property not found' });
  res.json(r);
});

// ---------- address lookup ----------
app.get('/api/admin/address-suggest', adminOnly, async (req, res, next) => {
  try { res.json(await addr.suggest(req.query.q || '')); } catch (e) { next(e); }
});
app.get('/api/admin/address-details', adminOnly, async (req, res, next) => {
  try { res.json(await addr.details(req.query.id, req.query.provider) || {}); } catch (e) { next(e); }
});

// ---------- amortization calculator ----------
// Give any three of principal, rate, term and payment; get the fourth plus the schedule.
app.get('/api/admin/amortize', adminOnly, (req, res) => {
  const q = req.query;
  res.json(loanEngine.solveLoan({
    principal_cents: q.principal_cents, payment_cents: q.payment_cents,
    interest_rate_bps: q.interest_rate_bps, term_months: q.term_months,
    first_payment_date: q.first_payment_date,
  }));
});

// Final payment date from a start date and term, and the reverse.
app.get('/api/admin/maturity', adminOnly, (req, res) => {
  const { first_payment_date, term_months, final_payment_date } = req.query;
  if (final_payment_date && first_payment_date) {
    return res.json({ term_months: loanEngine.termFromDates(first_payment_date, final_payment_date) });
  }
  res.json({ final_payment_date: loanEngine.finalPaymentDate(first_payment_date, Number(term_months)) });
});

// Live principal & interest calculation for the sale form.
app.get('/api/admin/calc-payment', adminOnly, (req, res) => {
  const principal = Number(req.query.principal_cents) || 0;
  const rate = Number(req.query.interest_rate_bps) || 0;
  const term = Number(req.query.term_months) || 0;
  if (!principal || !term) return res.json({ payment_cents: 0 });
  res.json({ payment_cents: loanEngine.calcPayment(principal, rate, term) });
});

// ---------- property profile: costs, basis, and the sale ----------
const COST_LABELS = {
  purchase: 'Purchase price', closing: 'Closing costs', filing: 'Filing & recording fees',
  rehab: 'Rehab / repairs', bog: 'Boots on the ground', insurance: 'Insurance',
  taxes: 'Property taxes', utilities: 'Utilities', marketing: 'Marketing',
  legal: 'Legal / title', other: 'Other',
};

function propertyBasis(propertyId) {
  const rows = all(`SELECT category, SUM(amount_cents) AS total FROM property_costs
    WHERE property_id=? GROUP BY category`, propertyId);
  const by = {};
  let total = 0;
  for (const r of rows) { by[r.category] = r.total; total += r.total; }
  return { by_category: by, total_cents: total };
}

app.get('/api/admin/properties/:id', adminOnly, (req, res) => {
  const prop = ownedProperty(req, req.params.id);
  if (!prop) return res.status(404).json({ error: 'Not found' });
  const basis = propertyBasis(prop.id);
  const loan = get(`SELECT * FROM loans WHERE property_id=? ORDER BY id DESC LIMIT 1`, prop.id);
  const tenant = loan && loan.tenant_user_id
    ? get('SELECT id, name, email, phone FROM users WHERE id=?', loan.tenant_user_id) : null;
  const pml = all('SELECT * FROM pml_loans WHERE property_id=?', prop.id);
  const expenses = get(`SELECT COALESCE(SUM(amount_cents),0) s FROM expenses
    WHERE property_id=? AND status='assigned'`, prop.id).s;
  res.json({
    property: prop,
    costs: all('SELECT * FROM property_costs WHERE property_id=? ORDER BY cost_date DESC, id DESC', prop.id),
    cost_labels: COST_LABELS,
    basis,
    returns: reports.propertyReturns(req.companyId, prop.id),
    assigned_expenses_cents: expenses,
    all_in_cents: basis.total_cents + expenses,
    loan: loan || null,
    tenant,
    pml_loans: pml,
    pml_balance_cents: pml.filter(p => p.status === 'active').reduce((t, p) => t + p.principal_balance_cents, 0),
    phases: PHASES, phase_labels: PHASE_LABELS, owner_types: OWNER_TYPES,
    doc_folders: (() => {
      const docs = all(`SELECT id, filename, category, title, effective_date, visible_to_tenant, created_at
        FROM documents WHERE property_id=? OR loan_id=? ORDER BY id DESC`, prop.id, loan ? loan.id : -1);
      const folders = {};
      for (const c of [...ADMIN_CATEGORIES, ...SHARED_CATEGORIES]) {
        folders[c] = { label: CATEGORY_LABELS[c], shared: SHARED_CATEGORIES.includes(c), documents: [] };
      }
      for (const d of docs) (folders[d.category] || folders.private).documents.push(d);
      return folders;
    })(),
  });
});

app.post('/api/admin/properties/:id/phase', adminOnly, (req, res) => {
  const p = ownedProperty(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (!PHASES.includes(req.body.phase)) return res.status(400).json({ error: 'Unknown phase' });
  run("UPDATE properties SET phase=?, phase_updated_at=datetime('now') WHERE id=?", req.body.phase, p.id);
  res.json({ ok: true, phase: req.body.phase });
});

app.put('/api/admin/properties/:id/details', adminOnly, (req, res) => {
  const p = ownedProperty(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  run(`UPDATE properties SET status=?, acquired_date=?, purchase_price_cents=?,
        target_sale_price_cents=?, beds=?, baths=?, sqft=?, year_built=?, notes=?,
        late_fee_cents=?, grace_days=?, due_day=?,
        owner_name=?, owner_type=?, trustee=? WHERE id=?`,
    b.status || p.status, b.acquired_date ?? p.acquired_date,
    b.purchase_price_cents ?? p.purchase_price_cents, b.target_sale_price_cents ?? p.target_sale_price_cents,
    b.beds ?? p.beds, b.baths ?? p.baths, b.sqft ?? p.sqft, b.year_built ?? p.year_built,
    b.notes ?? p.notes, b.late_fee_cents ?? p.late_fee_cents, b.grace_days ?? p.grace_days,
    b.due_day ?? p.due_day,
    b.owner_name ?? p.owner_name, b.owner_type ?? p.owner_type, b.trustee ?? p.trustee, p.id);
  res.json(get('SELECT * FROM properties WHERE id=?', p.id));
});

app.post('/api/admin/properties/:id/costs', adminOnly, (req, res) => {
  const p = ownedProperty(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const { category, description, vendor, amount_cents, cost_date } = req.body || {};
  if (!description || !amount_cents) return res.status(400).json({ error: 'Description and amount required' });
  const r = run(`INSERT INTO property_costs (company_id, property_id, category, description,
      vendor, amount_cents, cost_date, created_by) VALUES (?,?,?,?,?,?,?,?)`,
    req.companyId, p.id, category || 'other', description, vendor || null,
    amount_cents, cost_date || today(), req.user.id);
  // Keep the headline purchase price on the property in step with a "purchase" cost line.
  if ((category || '') === 'purchase') {
    run('UPDATE properties SET purchase_price_cents=? WHERE id=?', amount_cents, p.id);
  }
  res.json(get('SELECT * FROM property_costs WHERE id=?', r.lastInsertRowid));
});

app.delete('/api/admin/costs/:id', adminOnly, (req, res) => {
  const c = get('SELECT * FROM property_costs WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!c) return res.status(404).json({ error: 'Not found' });
  run('DELETE FROM property_costs WHERE id=?', c.id);
  res.json({ ok: true });
});

// Sell the property to a tenant buyer: creates their login, opens the loan, and
// prepares the text invitation in one action.
app.post('/api/admin/properties/:id/sell', adminOnly, async (req, res, next) => {
  const prop = ownedProperty(req, req.params.id);
  if (!prop) return res.status(404).json({ error: 'Property not found' });
  const b = req.body || {};
  for (const f of ['buyer_name', 'buyer_email', 'sale_price_cents', 'principal_cents',
                   'interest_rate_bps', 'term_months', 'first_payment_date']) {
    if (!b[f]) return res.status(400).json({ error: `Missing ${f}` });
  }
  const email = String(b.buyer_email).toLowerCase().trim();
  if (get('SELECT id FROM users WHERE email=?', email)) {
    return res.status(400).json({ error: 'That buyer email already has an account' });
  }
  try {
    const co = get('SELECT * FROM companies WHERE id=?', req.companyId);
    const temp = 'TB-' + crypto.randomInt(100000, 999999) + '!';
    const u = run(`INSERT INTO users (company_id, email, password_hash, role, name, phone, must_change_password)
      VALUES (?,?,?,?,?,?,1)`, req.companyId, email, hashPassword(temp), 'tenant',
      b.buyer_name, addr.formatPhone(b.buyer_phone) || null);
    // Principal & interest is computed from the note terms unless you deliberately override it.
    const payment = b.payment_cents ||
      loanEngine.calcPayment(b.principal_cents, b.interest_rate_bps, b.term_months);
    const taxes = b.monthly_taxes_cents || 0;
    const insurance = b.monthly_insurance_cents || 0;
    const utilities = b.monthly_utilities_cents || 0;
    const servicing = b.monthly_servicing_cents || 0;
    const misc = b.monthly_misc_cents || 0;
    // Taxes and insurance are the buyer's money until disbursed, so they sit in escrow.
    const escrow = taxes + insurance;
    const l = run(`INSERT INTO loans (company_id, property_id, tenant_user_id, loan_type,
        sale_price_cents, down_payment_cents, principal_cents, interest_rate_bps, term_months,
        payment_cents, escrow_cents, late_fee_cents, grace_days, first_payment_date, due_day,
        principal_balance_cents, beneficial_interest_pct)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      req.companyId, prop.id, u.lastInsertRowid, b.loan_type || 'land_contract',
      b.sale_price_cents, b.down_payment_cents || 0, b.principal_cents, b.interest_rate_bps,
      b.term_months, payment, escrow,
      b.late_fee_cents ?? prop.late_fee_cents ?? 0,
      b.grace_days ?? prop.grace_days ?? 5,
      b.first_payment_date,
      b.due_day ?? prop.due_day ?? Number(String(b.first_payment_date).slice(8, 10)),
      b.principal_cents, b.beneficial_interest_pct || null);
    const loanId = l.lastInsertRowid;
    run('UPDATE loans SET final_payment_date=? WHERE id=?',
      loanEngine.finalPaymentDate(b.first_payment_date, b.term_months), loanId);
    run(`UPDATE loans SET monthly_taxes_cents=?, monthly_insurance_cents=?, monthly_utilities_cents=?,
          monthly_servicing_cents=?, monthly_misc_cents=?, misc_label=? WHERE id=?`,
      taxes, insurance, utilities, servicing, misc, b.misc_label || 'Other monthly charge', loanId);
    // Utilities, the servicing fee and anything miscellaneous are billed as recurring
    // charges — they are income to you, not money held for the buyer.
    for (const [amount, category, label] of [
      [utilities, 'utilities', 'Utilities'],
      [servicing, 'servicing_fee', 'Servicing fee'],
      [misc, 'other', b.misc_label || 'Other monthly charge'],
    ]) {
      if (amount > 0) {
        run(`INSERT INTO charges (loan_id, description, category, amount_cents, recurring, start_date)
             VALUES (?,?,?,?,1,?)`, loanId, label, category, amount, b.first_payment_date);
      }
    }
    run("UPDATE properties SET status='sold', phase='sold', phase_updated_at=datetime('now') WHERE id=?", prop.id);

    const inv = run(`INSERT INTO invitations (company_id, loan_id, user_id, phone, temp_password, channel)
      VALUES (?,?,?,?,?,?)`, req.companyId, l.lastInsertRowid, u.lastInsertRowid,
      sms.normalizePhone(b.buyer_phone), temp, b.buyer_phone ? 'sms' : 'manual');

    res.json({
      loan_id: l.lastInsertRowid, tenant_user_id: u.lastInsertRowid,
      invitation_id: inv.lastInsertRowid, temp_password: temp,
      sms_enabled: sms.smsEnabled(),
    });
  } catch (e) { next(e); }
});

// ---------- invitations ----------
function inviteBody(req, invId) {
  const inv = get('SELECT * FROM invitations WHERE id=? AND company_id=?', invId, req.companyId);
  if (!inv) return null;
  const u = get('SELECT * FROM users WHERE id=?', inv.user_id);
  const co = get('SELECT * FROM companies WHERE id=?', inv.company_id);
  const loan = inv.loan_id ? get('SELECT * FROM loans WHERE id=?', inv.loan_id) : null;
  const prop = loan ? get('SELECT * FROM properties WHERE id=?', loan.property_id) : null;
  return {
    inv, user: u,
    text: sms.inviteMessage({
      buyerName: u ? u.name : '', companyName: co.name,
      address: prop ? prop.address : 'your new home',
      url: baseUrlOf(req) + '/', email: u ? u.email : '',
      tempPassword: inv.temp_password,
    }),
  };
}
app.get('/api/admin/invitations', adminOnly, (req, res) => {
  res.json({
    sms_enabled: sms.smsEnabled(),
    invitations: all(`SELECT i.*, u.name AS buyer_name, u.email AS buyer_email, p.address
      FROM invitations i LEFT JOIN users u ON u.id=i.user_id
      LEFT JOIN loans l ON l.id=i.loan_id LEFT JOIN properties p ON p.id=l.property_id
      WHERE i.company_id=? ORDER BY i.id DESC`, req.companyId),
  });
});
app.get('/api/admin/invitations/:id/preview', adminOnly, (req, res) => {
  const d = inviteBody(req, req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json({ text: d.text, phone: d.inv.phone, sms_enabled: sms.smsEnabled(),
    buyer_name: d.user ? d.user.name : '', status: d.inv.status });
});
app.post('/api/admin/invitations/:id/send', adminOnly, async (req, res, next) => {
  const d = inviteBody(req, req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const phone = sms.normalizePhone(req.body.phone || d.inv.phone);
  if (!phone) return res.status(400).json({ error: 'No mobile number on file for this buyer' });
  if (!sms.smsEnabled()) {
    return res.status(400).json({ error: 'Texting is not set up yet. Copy the message and send it from your phone, or add your Twilio details.', text: d.text });
  }
  try {
    await sms.sendSms(phone, d.text);
    run("UPDATE invitations SET status='sent', phone=?, sent_at=datetime('now'), error=NULL WHERE id=?", phone, d.inv.id);
    res.json({ ok: true });
  } catch (e) {
    run("UPDATE invitations SET status='failed', error=? WHERE id=?", e.message, d.inv.id);
    next(e);
  }
});
app.post('/api/admin/invitations/:id/mark-sent', adminOnly, (req, res) => {
  const inv = get('SELECT * FROM invitations WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  run("UPDATE invitations SET status='sent', channel='manual', sent_at=datetime('now') WHERE id=?", inv.id);
  res.json({ ok: true });
});

// ---------- admin: tenant buyers ----------
app.get('/api/admin/tenants', adminOnly, (req, res) => {
  const archived = req.query.archived === '1';
  const rows = all(`SELECT id, name, email, phone, terms_accepted_at, location_consent_at,
      archived_at, archived_reason, created_at
    FROM users WHERE role='tenant' AND company_id=? AND deleted_at IS NULL
      AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'} ORDER BY id DESC`, req.companyId);
  for (const t of rows) {
    const loan = get(`SELECT l.id, p.address FROM loans l LEFT JOIN properties p ON p.id=l.property_id
      WHERE l.tenant_user_id=? AND l.company_id=? ORDER BY l.id DESC LIMIT 1`, t.id, req.companyId);
    t.loan = loan || null;
  }
  res.json(rows);
});
app.post('/api/admin/tenants', adminOnly, (req, res) => {
  const { name, email, phone } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  if (get('SELECT id FROM users WHERE email=?', email.toLowerCase().trim())) return res.status(400).json({ error: 'Email already exists' });
  const temp = 'TB-' + crypto.randomInt(100000, 999999) + '!';
  const r = run('INSERT INTO users (company_id, email, password_hash, role, name, phone, must_change_password) VALUES (?,?,?,?,?,?,1)',
    req.companyId, email.toLowerCase().trim(), hashPassword(temp), 'tenant', name, addr.formatPhone(phone) || null);
  res.json({ id: r.lastInsertRowid, name, email, phone, temp_password: temp });
});
app.post('/api/admin/tenants/:id/reset-password', adminOnly, (req, res) => {
  const u = get("SELECT id FROM users WHERE id=? AND role='tenant' AND company_id=?", req.params.id, req.companyId);
  if (!u) return res.status(404).json({ error: 'Buyer not found' });
  const temp = 'TB-' + crypto.randomInt(100000, 999999) + '!';
  run('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?', hashPassword(temp), u.id);
  res.json({ temp_password: temp });
});

// ---------- admin: archive, restore, delete users ----------
// Archiving is reversible and keeps every record — use it for a paid-off buyer or a
// staffer who left. Deleting erases personal data permanently and cannot be undone.
function companyUser(req, id, roles) {
  return get(`SELECT * FROM users WHERE id=? AND company_id=? AND deleted_at IS NULL
    AND role IN (${roles.map(() => '?').join(',')})`, id, req.companyId, ...roles);
}
app.post('/api/admin/tenants/:id/archive', adminOnly, (req, res) => {
  const u = companyUser(req, req.params.id, ['tenant']);
  if (!u) return res.status(404).json({ error: 'Buyer not found' });
  if (u.archived_at) return res.status(400).json({ error: 'Already archived' });
  run("UPDATE users SET archived_at=datetime('now'), archived_reason=? WHERE id=?",
    req.body.reason || null, u.id);
  res.json({ ok: true });
});
app.post('/api/admin/tenants/:id/restore', adminOnly, (req, res) => {
  const u = companyUser(req, req.params.id, ['tenant']);
  if (!u) return res.status(404).json({ error: 'Buyer not found' });
  run('UPDATE users SET archived_at=NULL, archived_reason=NULL WHERE id=?', u.id);
  res.json({ ok: true });
});
app.delete('/api/admin/tenants/:id', adminOnly, (req, res, next) => {
  const u = companyUser(req, req.params.id, ['tenant']);
  if (!u) return res.status(404).json({ error: 'Buyer not found' });
  if (req.body && req.body.confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Type DELETE to confirm' });
  }
  try { eraseUser(u.id, 'tenant'); res.json({ ok: true }); } catch (e) { next(e); }
});
app.post('/api/admin/staff/:id/archive', ownerOnly, (req, res) => {
  const u = companyUser(req, req.params.id, ['admin']);
  if (!u) return res.status(404).json({ error: 'Staff member not found' });
  run("UPDATE users SET archived_at=datetime('now'), archived_reason=? WHERE id=?",
    req.body.reason || null, u.id);
  res.json({ ok: true });
});
app.post('/api/admin/staff/:id/restore', ownerOnly, (req, res) => {
  const u = companyUser(req, req.params.id, ['admin']);
  if (!u) return res.status(404).json({ error: 'Staff member not found' });
  run('UPDATE users SET archived_at=NULL, archived_reason=NULL WHERE id=?', u.id);
  res.json({ ok: true });
});

// ---------- admin: loans ----------
app.get('/api/admin/loans', adminOnly, (req, res) => {
  const loans = all('SELECT * FROM loans WHERE company_id=? ORDER BY id DESC', req.companyId);
  res.json(loans.map(l => {
    const f = loanFull(l);
    return { ...f.loan, address: f.property ? f.property.address : '', tenant_name: f.tenant ? f.tenant.name : null, status_info: f.status };
  }));
});
app.post('/api/admin/loans', adminOnly, (req, res) => {
  const b = req.body || {};
  const req_fields = ['property_id', 'sale_price_cents', 'principal_cents', 'interest_rate_bps', 'term_months', 'first_payment_date'];
  for (const f of req_fields) if (b[f] === undefined || b[f] === null || b[f] === '') return res.status(400).json({ error: `Missing ${f}` });
  if (!ownedProperty(req, b.property_id)) return res.status(404).json({ error: 'Property not found' });
  if (b.tenant_user_id && !get("SELECT id FROM users WHERE id=? AND role='tenant' AND company_id=?", b.tenant_user_id, req.companyId))
    return res.status(404).json({ error: 'Buyer not found' });
  const payment = b.payment_cents || loanEngine.calcPayment(b.principal_cents, b.interest_rate_bps, b.term_months);
  const r = run(`INSERT INTO loans (company_id, property_id, tenant_user_id, loan_type, sale_price_cents, down_payment_cents,
      principal_cents, interest_rate_bps, term_months, payment_cents, escrow_cents, late_fee_cents, grace_days,
      first_payment_date, due_day, principal_balance_cents, beneficial_interest_pct)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    req.companyId, b.property_id, b.tenant_user_id || null, b.loan_type || 'land_contract', b.sale_price_cents,
    b.down_payment_cents || 0, b.principal_cents, b.interest_rate_bps, b.term_months, payment,
    b.escrow_cents || 0, b.late_fee_cents || 0, b.grace_days ?? 5, b.first_payment_date,
    b.due_day || Number(b.first_payment_date.slice(8, 10)), b.principal_cents, b.beneficial_interest_pct || null);
  res.json(loanFull(get('SELECT * FROM loans WHERE id=?', r.lastInsertRowid)));
});
app.get('/api/admin/loans/:id', adminOnly, (req, res) => {
  const loan = ownedLoan(req, req.params.id);
  if (!loan) return res.status(404).json({ error: 'Not found' });
  const f = loanFull(loan);
  f.schedule = loanEngine.amortizationSchedule(loan);
  f.payoff = loanEngine.payoffQuote(f.loan, today());
  f.documents = all('SELECT id, filename, kind, visible_to_tenant, created_at FROM documents WHERE loan_id=?', loan.id);
  res.json(f);
});
app.put('/api/admin/loans/:id', adminOnly, (req, res) => {
  const loan = ownedLoan(req, req.params.id);
  if (!loan) return res.status(404).json({ error: 'Not found' });
  const allowed = ['tenant_user_id', 'status', 'escrow_cents', 'late_fee_cents', 'grace_days', 'loan_type', 'beneficial_interest_pct', 'payment_cents'];
  const sets = [], vals = [];
  for (const k of allowed) if (req.body[k] !== undefined) { sets.push(`${k}=?`); vals.push(req.body[k]); }
  if (sets.length) run(`UPDATE loans SET ${sets.join(',')} WHERE id=?`, ...vals, loan.id);
  res.json(loanFull(get('SELECT * FROM loans WHERE id=?', loan.id)));
});
app.post('/api/admin/loans/:id/payments', adminOnly, (req, res) => {
  const { amount_cents, method, entry_date, memo } = req.body || {};
  if (!ownedLoan(req, req.params.id)) return res.status(404).json({ error: 'Loan not found' });
  if (!amount_cents || amount_cents <= 0) return res.status(400).json({ error: 'Amount required' });
  const result = postPayment(Number(req.params.id), amount_cents, method || 'cash', entry_date || today(), null, memo, req.user.id);
  res.json(result);
});
app.post('/api/admin/loans/:id/latefee', adminOnly, (req, res) => {
  const loan = ownedLoan(req, req.params.id);
  if (!loan) return res.status(404).json({ error: 'Not found' });
  const amt = req.body.amount_cents || loan.late_fee_cents;
  if (!amt) return res.status(400).json({ error: 'No late fee configured' });
  run('INSERT INTO ledger (loan_id, entry_date, type, amount_cents, memo, created_by) VALUES (?,?,?,?,?,?)',
    loan.id, today(), 'late_fee', -amt, req.body.memo || 'Late fee', req.user.id);
  run('UPDATE loans SET fees_due_cents = fees_due_cents + ? WHERE id=?', amt, loan.id);
  res.json({ ok: true });
});
app.post('/api/admin/loans/:id/charges', adminOnly, (req, res) => {
  const loan = ownedLoan(req, req.params.id);
  if (!loan) return res.status(404).json({ error: 'Not found' });
  const { description, amount_cents, recurring, start_date, end_date, category } = req.body || {};
  if (!description || !amount_cents) return res.status(400).json({ error: 'Description and amount required' });
  const r = run('INSERT INTO charges (loan_id, description, category, amount_cents, recurring, start_date, end_date) VALUES (?,?,?,?,?,?,?)',
    loan.id, description, category || 'other', amount_cents, recurring ? 1 : 0, start_date || today(), end_date || null);
  if (!recurring) {
    run('INSERT INTO ledger (loan_id, entry_date, type, amount_cents, memo, created_by) VALUES (?,?,?,?,?,?)',
      loan.id, today(), 'fee', -amount_cents, description, req.user.id);
    run('UPDATE loans SET fees_due_cents = fees_due_cents + ? WHERE id=?', amount_cents, loan.id);
  }
  res.json(get('SELECT * FROM charges WHERE id=?', r.lastInsertRowid));
});
app.delete('/api/admin/charges/:id', adminOnly, (req, res) => {
  const ch = get(`SELECT c.id FROM charges c JOIN loans l ON l.id=c.loan_id WHERE c.id=? AND l.company_id=?`, req.params.id, req.companyId);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  run('UPDATE charges SET active=0 WHERE id=?', ch.id);
  res.json({ ok: true });
});

// ---------- admin: documents & AI ----------
// Shared folders both the admin and the tenant buyer can see, plus the admin-only vault.
// Folders the buyer can see once the house is theirs.
const SHARED_CATEGORIES = ['loan_docs', 'insurance', 'taxes', 'utilities', 'correspondence'];
// Folders only you see — the paperwork from your side of the deal.
const ADMIN_CATEGORIES = ['acquisition', 'pml_docs', 'sale_closing', 'private'];
const CATEGORY_LABELS = {
  acquisition: 'Acquisition closing docs', pml_docs: 'Private money loan docs',
  sale_closing: 'Sale closing docs', loan_docs: 'Loan Documents', insurance: 'Insurance',
  taxes: 'Taxes', utilities: 'Utilities', correspondence: 'Correspondence',
  private: 'Private (admin only)', statement: 'Statements', other: 'Other',
};

// Property lifecycle. Selling to a buyer moves it to 'sold' automatically.
const OWNER_TYPES = {
  individual: 'Individual', llc: 'LLC', land_trust: 'Land Trust',
  corporation: 'Corporation', partnership: 'Partnership', other: 'Other',
};
const PHASES = ['acquired', 'rehab', 'ready', 'listed', 'sold', 'paid_off'];
const PHASE_LABELS = {
  acquired: 'Acquired', rehab: 'In rehab', ready: 'Ready to sell',
  listed: 'Listed', sold: 'Sold — servicing', paid_off: 'Paid off',
};

app.post('/api/admin/documents', adminOnly, (req, res) => {
  const { filename, mime, data_base64, kind, loan_id, property_id, visible_to_tenant, category, title, effective_date } = req.body || {};
  if (!filename || !data_base64) return res.status(400).json({ error: 'File required' });
  if (loan_id && !ownedLoan(req, loan_id)) return res.status(404).json({ error: 'Loan not found' });
  if (property_id && !ownedProperty(req, property_id)) return res.status(404).json({ error: 'Property not found' });
  const cat = category || 'other';
  // Anything filed as "private" is admin-only regardless of the flag sent.
  const shared = cat !== 'private' && cat !== 'statement' && visible_to_tenant ? 1 : 0;
  const stored = crypto.randomUUID() + path.extname(filename);
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), Buffer.from(data_base64, 'base64'));
  const r = run(`INSERT INTO documents (company_id, loan_id, property_id, kind, category, title, effective_date,
      filename, stored_name, mime, visible_to_tenant, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, req.companyId, loan_id || null, property_id || null, kind || 'closing', cat,
    title || null, effective_date || null, filename, stored, mime || null, shared, req.user.id);
  if (shared && loan_id) {
    const ln = get('SELECT tenant_user_id FROM loans WHERE id=?', loan_id);
    if (ln && ln.tenant_user_id) {
      notify.notify(ln.tenant_user_id, {
        kind: 'document', title: 'A new document was shared with you',
        body: title || filename, url: '/?tab=docs',
      }).catch(() => {});
    }
  }
  res.json(get('SELECT id, filename, kind, category, title, visible_to_tenant, created_at FROM documents WHERE id=?', r.lastInsertRowid));
});

// Admin document center for a loan: every shared folder plus the private vault.
app.get('/api/admin/loans/:id/documents', adminOnly, (req, res) => {
  const loan = ownedLoan(req, req.params.id);
  if (!loan) return res.status(404).json({ error: 'Not found' });
  const docs = all(`SELECT id, filename, kind, category, title, effective_date, mime, visible_to_tenant, created_at
    FROM documents WHERE loan_id=? OR (property_id IS NOT NULL AND property_id=?)
    ORDER BY COALESCE(effective_date, created_at) DESC, id DESC`, loan.id, loan.property_id);
  const folders = {};
  for (const c of [...SHARED_CATEGORIES, 'private']) folders[c] = { label: CATEGORY_LABELS[c], shared: c !== 'private', documents: [] };
  for (const d of docs) {
    const key = d.visible_to_tenant ? (SHARED_CATEGORIES.includes(d.category) ? d.category : 'loan_docs') : 'private';
    folders[key].documents.push(d);
  }
  res.json(folders);
});

app.put('/api/admin/documents/:id', adminOnly, (req, res) => {
  const doc = get('SELECT * FROM documents WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const category = req.body.category !== undefined ? req.body.category : doc.category;
  const vis = req.body.visible_to_tenant !== undefined ? (req.body.visible_to_tenant ? 1 : 0) : doc.visible_to_tenant;
  const shared = category === 'private' ? 0 : vis;
  run('UPDATE documents SET category=?, visible_to_tenant=?, title=?, effective_date=? WHERE id=?',
    category, shared, req.body.title !== undefined ? req.body.title : doc.title,
    req.body.effective_date !== undefined ? req.body.effective_date : doc.effective_date, doc.id);
  res.json(get('SELECT id, filename, category, title, visible_to_tenant FROM documents WHERE id=?', doc.id));
});

app.delete('/api/admin/documents/:id', adminOnly, (req, res) => {
  const doc = get('SELECT * FROM documents WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, doc.stored_name)); } catch {}
  run('DELETE FROM documents WHERE id=?', doc.id);
  res.json({ ok: true });
});

// Tenant buyer document center — shared folders only, always present as placeholders.
app.get('/api/tenant/documents', tenantReady, (req, res) => {
  const loan = get('SELECT * FROM loans WHERE tenant_user_id=? ORDER BY id DESC LIMIT 1', req.user.id);
  const folders = SHARED_CATEGORIES.map(c => ({ category: c, label: CATEGORY_LABELS[c], documents: [] }));
  if (!loan) return res.json(folders);
  const docs = all(`SELECT id, filename, category, title, effective_date, created_at FROM documents
    WHERE visible_to_tenant=1 AND (loan_id=? OR (property_id IS NOT NULL AND property_id=?))
    ORDER BY COALESCE(effective_date, created_at) DESC, id DESC`, loan.id, loan.property_id);
  for (const d of docs) {
    const f = folders.find(x => x.category === d.category) || folders[0];
    f.documents.push(d);
  }
  res.json(folders);
});
app.get('/api/documents/:id/download', anyUser, (req, res) => {
  const doc = get('SELECT * FROM documents WHERE id=?', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.company_id !== req.user.company_id) return res.status(403).json({ error: 'Forbidden' });
  if (req.user.role === 'tenant') {
    const loan = get('SELECT * FROM loans WHERE id=? AND tenant_user_id=?', doc.loan_id, req.user.id);
    if (!loan || !doc.visible_to_tenant) return res.status(403).json({ error: 'Forbidden' });
  }
  res.setHeader('Content-Disposition', `attachment; filename="${doc.filename.replace(/"/g, '')}"`);
  if (doc.mime) res.setHeader('Content-Type', doc.mime);
  res.send(fs.readFileSync(path.join(UPLOAD_DIR, doc.stored_name)));
});
// AI: extract loan terms from one or more closing docs
app.post('/api/admin/ai/extract-loan', adminOnly, async (req, res) => {
  if (!ai.aiEnabled()) return res.status(400).json({ error: 'AI not configured. Set ANTHROPIC_API_KEY on the server.' });
  const ids = req.body.document_ids || [];
  if (!ids.length) return res.status(400).json({ error: 'document_ids required' });
  try {
    const files = ids.map(id => {
      const doc = get('SELECT * FROM documents WHERE id=? AND company_id=?', id, req.companyId);
      if (!doc) throw new Error('Document not found');
      return { buffer: fs.readFileSync(path.join(UPLOAD_DIR, doc.stored_name)), mime: doc.mime || 'application/pdf', filename: doc.filename };
    });
    const extracted = await ai.extractLoanTerms(files);
    run('UPDATE documents SET extracted_json=? WHERE id=?', JSON.stringify(extracted), ids[0]);
    res.json(extracted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// AI: extract transactions from a bank/CC statement -> expenses for review
app.post('/api/admin/ai/extract-transactions', adminOnly, async (req, res) => {
  if (!ai.aiEnabled()) return res.status(400).json({ error: 'AI not configured. Set ANTHROPIC_API_KEY on the server.' });
  const doc = get('SELECT * FROM documents WHERE id=? AND company_id=?', req.body.document_id, req.companyId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  try {
    const props = all('SELECT id, address, city FROM properties WHERE company_id=?', req.companyId);
    const file = { buffer: fs.readFileSync(path.join(UPLOAD_DIR, doc.stored_name)), mime: doc.mime || 'application/pdf', filename: doc.filename };
    const out = await ai.extractTransactions(file, props);
    let count = 0;
    for (const t of out.transactions || []) {
      const sugg = t.suggested_property_id && ownedProperty(req, t.suggested_property_id) ? t.suggested_property_id : null;
      run(`INSERT INTO expenses (company_id, property_id, document_id, txn_date, description, amount_cents, category, status)
           VALUES (?,?,?,?,?,?,?,?)`,
        req.companyId, sugg, doc.id, t.date || null, t.description || '(no description)',
        Math.round((t.amount || 0) * 100), t.category || null, 'unassigned');
      count++;
    }
    res.json({ imported: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- admin: expenses ----------
app.get('/api/admin/expenses', adminOnly, (req, res) => {
  const status = req.query.status;
  const rows = status
    ? all(`SELECT e.*, p.address FROM expenses e LEFT JOIN properties p ON p.id=e.property_id
           WHERE e.status=? AND e.company_id=? ORDER BY e.txn_date DESC, e.id DESC`, status, req.companyId)
    : all(`SELECT e.*, p.address FROM expenses e LEFT JOIN properties p ON p.id=e.property_id
           WHERE e.company_id=? ORDER BY e.txn_date DESC, e.id DESC`, req.companyId);
  res.json(rows);
});
app.post('/api/admin/expenses', adminOnly, (req, res) => {
  const { property_id, txn_date, description, amount_cents, category } = req.body || {};
  if (!description || !amount_cents) return res.status(400).json({ error: 'Description and amount required' });
  if (property_id && !ownedProperty(req, property_id)) return res.status(404).json({ error: 'Property not found' });
  const r = run('INSERT INTO expenses (company_id, property_id, txn_date, description, amount_cents, category, status) VALUES (?,?,?,?,?,?,?)',
    req.companyId, property_id || null, txn_date || today(), description, amount_cents, category || null, property_id ? 'assigned' : 'unassigned');
  res.json(get('SELECT * FROM expenses WHERE id=?', r.lastInsertRowid));
});
app.put('/api/admin/expenses/:id', adminOnly, (req, res) => {
  const e = get('SELECT * FROM expenses WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!e) return res.status(404).json({ error: 'Not found' });
  const property_id = req.body.property_id !== undefined ? req.body.property_id : e.property_id;
  if (property_id && !ownedProperty(req, property_id)) return res.status(404).json({ error: 'Property not found' });
  const status = req.body.status || (property_id ? 'assigned' : e.status);
  run('UPDATE expenses SET property_id=?, status=?, category=? WHERE id=?',
    property_id, status, req.body.category !== undefined ? req.body.category : e.category, e.id);
  res.json(get('SELECT * FROM expenses WHERE id=?', e.id));
});

// ---------- message templates ----------
// Everything a template needs to render for a given loan: company, buyer, balances.
function mergeContextForLoan(req, loanId) {
  const loan = loanId ? get('SELECT * FROM loans WHERE id=?', loanId) : null;
  const company = get('SELECT * FROM companies WHERE id=?', req.companyId);
  const property = loan ? get('SELECT * FROM properties WHERE id=?', loan.property_id) : null;
  const buyer = loan && loan.tenant_user_id ? get('SELECT * FROM users WHERE id=?', loan.tenant_user_id) : null;
  let status = null, payoff = null;
  if (loan) {
    const ledger = all('SELECT * FROM ledger WHERE loan_id=?', loan.id);
    status = loanEngine.loanStatus(loan, ledger, today());
    payoff = loanEngine.payoffQuote(loan, today());
  }
  return { company, buyer, loan, property, status, payoff, baseUrl: baseUrlOf(req) };
}

app.get('/api/admin/templates', adminOnly, (req, res) => {
  tpl.seedTemplates(req.companyId);
  res.json({
    merge_fields: tpl.MERGE_FIELDS,
    templates: all(`SELECT * FROM message_templates WHERE company_id=? AND archived=0
      ORDER BY is_starter DESC, name`, req.companyId),
  });
});
app.post('/api/admin/templates', adminOnly, (req, res) => {
  const { name, subject, body_html, category } = req.body || {};
  if (!name || !body_html) return res.status(400).json({ error: 'Name and message body are required' });
  const r = run(`INSERT INTO message_templates (company_id, name, category, subject, body_html)
    VALUES (?,?,?,?,?)`, req.companyId, name, category || 'general', subject || null,
    tpl.sanitizeHtml(body_html));
  res.json(get('SELECT * FROM message_templates WHERE id=?', r.lastInsertRowid));
});
app.put('/api/admin/templates/:id', adminOnly, (req, res) => {
  const t = get('SELECT * FROM message_templates WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  run(`UPDATE message_templates SET name=?, category=?, subject=?, body_html=? WHERE id=?`,
    b.name || t.name, b.category || t.category, b.subject ?? t.subject,
    b.body_html ? tpl.sanitizeHtml(b.body_html) : t.body_html, t.id);
  res.json(get('SELECT * FROM message_templates WHERE id=?', t.id));
});
app.delete('/api/admin/templates/:id', adminOnly, (req, res) => {
  const t = get('SELECT * FROM message_templates WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!t) return res.status(404).json({ error: 'Not found' });
  run('UPDATE message_templates SET archived=1 WHERE id=?', t.id);
  res.json({ ok: true });
});
// Preview a template with real values merged in, in the branded shell.
app.post('/api/admin/templates/preview', adminOnly, (req, res) => {
  const ctx = mergeContextForLoan(req, req.body.loan_id || null);
  const values = tpl.buildMergeValues(ctx);
  const bodyRaw = req.body.body_html || '';
  const subject = tpl.applyMerge(req.body.subject || '', values);
  const merged = tpl.applyMerge(tpl.sanitizeHtml(bodyRaw), values);
  res.json({
    subject,
    html: tpl.brandedShell({ company: ctx.company, bodyHtml: merged, subject, baseUrl: ctx.baseUrl }),
    text: tpl.htmlToText(merged),
    values,
  });
});

// ---------- messages (shared) ----------
app.get('/api/admin/messages', adminOnly, (req, res) => {
  const threads = all(`
    SELECT l.id AS loan_id, p.address, u.name AS tenant_name,
      (SELECT body FROM messages WHERE loan_id=l.id ORDER BY id DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages WHERE loan_id=l.id ORDER BY id DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*) FROM messages WHERE loan_id=l.id AND read_by_admin=0) AS unread
    FROM loans l LEFT JOIN properties p ON p.id=l.property_id LEFT JOIN users u ON u.id=l.tenant_user_id
    WHERE l.tenant_user_id IS NOT NULL AND l.company_id=? ORDER BY last_at DESC`, req.companyId);
  res.json(threads);
});
app.get('/api/admin/loans/:id/messages', adminOnly, (req, res) => {
  if (!ownedLoan(req, req.params.id)) return res.status(404).json({ error: 'Loan not found' });
  run('UPDATE messages SET read_by_admin=1 WHERE loan_id=?', req.params.id);
  res.json(all('SELECT m.*, u.name AS sender_name, u.role AS sender_role FROM messages m JOIN users u ON u.id=m.sender_user_id WHERE m.loan_id=? ORDER BY m.id', req.params.id));
});
app.post('/api/admin/loans/:id/messages', adminOnly, (req, res) => {
  const loan = ownedLoan(req, req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  const b = req.body || {};
  if (!b.body && !b.body_html) return res.status(400).json({ error: 'Message required' });

  // A plain typed message stays plain. A template or HTML body is merged, sanitised,
  // and wrapped in the company's letterhead before it is stored.
  if (b.body_html) {
    const ctx = mergeContextForLoan(req, loan.id);
    const values = tpl.buildMergeValues(ctx);
    const subject = tpl.applyMerge(b.subject || '', values);
    const merged = tpl.applyMerge(tpl.sanitizeHtml(b.body_html), values);
    const html = tpl.brandedShell({ company: ctx.company, bodyHtml: merged, subject, baseUrl: ctx.baseUrl });
    run(`INSERT INTO messages (loan_id, sender_user_id, body, body_html, subject, template_id, read_by_admin)
         VALUES (?,?,?,?,?,?,1)`, loan.id, req.user.id, tpl.htmlToText(merged), html,
      subject || null, b.template_id || null);
  } else {
    run('INSERT INTO messages (loan_id, sender_user_id, body, read_by_admin) VALUES (?,?,?,1)',
      loan.id, req.user.id, b.body);
  }
  if (loan.tenant_user_id) {
    const co = get('SELECT name FROM companies WHERE id=?', req.companyId);
    notify.notify(loan.tenant_user_id, {
      kind: 'message', title: `New message from ${co ? co.name : 'your servicer'}`,
      body: b.subject || (b.body || '').slice(0, 120), url: '/?tab=msgs',
    }).catch(() => {});
  }
  res.json({ ok: true });
});

// ---------- PML loans (admin only — never exposed to tenant routes) ----------
app.get('/api/admin/pml', adminOnly, (req, res) => {
  const rows = all(`SELECT pl.*, p.address FROM pml_loans pl LEFT JOIN properties p ON p.id=pl.property_id
    WHERE pl.company_id=? ORDER BY pl.id DESC`, req.companyId);
  for (const r of rows) {
    const tb = get("SELECT payment_cents, escrow_cents FROM loans WHERE property_id=? AND status='active' AND company_id=? ORDER BY id DESC LIMIT 1", r.property_id, req.companyId);
    r.tb_payment_cents = tb ? tb.payment_cents + tb.escrow_cents : 0;
    r.monthly_spread_cents = r.tb_payment_cents - r.payment_cents;
    r.next_due_date = loanEngine.nextDueDate(r, today());
  }
  res.json(rows);
});
app.post('/api/admin/pml', adminOnly, (req, res) => {
  const b = req.body || {};
  for (const f of ['property_id', 'lender_name', 'principal_cents', 'interest_rate_bps', 'term_months', 'first_payment_date'])
    if (!b[f]) return res.status(400).json({ error: `Missing ${f}` });
  const type = b.payment_type || 'amortized';
  let payment = b.payment_cents;
  if (!payment) {
    payment = type === 'interest_only'
      ? Math.round(b.principal_cents * (b.interest_rate_bps / 10000) / 12)
      : loanEngine.calcPayment(b.principal_cents, b.interest_rate_bps, b.term_months);
  }
  if (!ownedProperty(req, b.property_id)) return res.status(404).json({ error: 'Property not found' });
  const r = run(`INSERT INTO pml_loans (company_id, property_id, lender_name, lender_contact, lien_position, principal_cents,
      interest_rate_bps, term_months, payment_type, payment_cents, balloon_date, first_payment_date,
      principal_balance_cents, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    req.companyId, b.property_id, b.lender_name, b.lender_contact || null, b.lien_position || 1, b.principal_cents,
    b.interest_rate_bps, b.term_months, type, payment, b.balloon_date || null, b.first_payment_date,
    b.principal_cents, b.notes || null);
  res.json(get('SELECT * FROM pml_loans WHERE id=?', r.lastInsertRowid));
});
app.get('/api/admin/pml/:id', adminOnly, (req, res) => {
  const pml = get('SELECT * FROM pml_loans WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!pml) return res.status(404).json({ error: 'Not found' });
  const property = get('SELECT * FROM properties WHERE id=?', pml.property_id);
  const ledger = all('SELECT * FROM pml_ledger WHERE pml_loan_id=? ORDER BY entry_date, id', pml.id);
  const tb = get("SELECT * FROM loans WHERE property_id=? AND status='active' AND company_id=? ORDER BY id DESC LIMIT 1", pml.property_id, req.companyId);
  const schedule = pml.payment_type === 'amortized' ? loanEngine.amortizationSchedule({
    first_payment_date: pml.first_payment_date, principal_cents: pml.principal_cents,
    interest_rate_bps: pml.interest_rate_bps, term_months: pml.term_months, payment_cents: pml.payment_cents,
  }) : [];
  res.json({
    pml, property, ledger, schedule,
    payoff: loanEngine.payoffQuote({ ...pml, fees_due_cents: 0, escrow_balance_cents: 0 }, today()),
    next_due_date: loanEngine.nextDueDate(pml, today()),
    tb_loan: tb ? { id: tb.id, payment_cents: tb.payment_cents + tb.escrow_cents, balance_cents: tb.principal_balance_cents } : null,
    monthly_spread_cents: (tb ? tb.payment_cents + tb.escrow_cents : 0) - pml.payment_cents,
    equity_spread_cents: (tb ? tb.principal_balance_cents : 0) - pml.principal_balance_cents,
  });
});
app.post('/api/admin/pml/:id/payments', adminOnly, (req, res) => {
  const pml = get('SELECT * FROM pml_loans WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!pml) return res.status(404).json({ error: 'Not found' });
  const amount = Number(req.body.amount_cents);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount required' });
  const r = pml.interest_rate_bps / 10000 / 12;
  const interestOwed = pml.interest_due_cents || Math.round(pml.principal_balance_cents * r);
  const toInterest = Math.min(amount, interestOwed);
  const toPrincipal = Math.min(amount - toInterest, pml.principal_balance_cents);
  const newBal = pml.principal_balance_cents - toPrincipal;
  run(`INSERT INTO pml_ledger (pml_loan_id, entry_date, type, amount_cents, to_interest_cents,
        to_principal_cents, principal_balance_after_cents, memo, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    pml.id, req.body.entry_date || today(), 'payment', amount, toInterest, toPrincipal, newBal,
    req.body.memo || null, req.user.id);
  run(`UPDATE pml_loans SET principal_balance_cents=?, interest_due_cents=?,
        status=CASE WHEN ?<=0 THEN 'paid_off' ELSE status END WHERE id=?`,
    newBal, Math.max(0, interestOwed - toInterest), newBal, pml.id);
  res.json({ to_interest_cents: toInterest, to_principal_cents: toPrincipal, balance_cents: newBal });
});
// Scheduling for lender payments. This does NOT move money — see the note in the UI.
// It tracks when each payment is due, reminds you, and can auto-record a payment you
// have already set up to go out from your bank so the ledger stays accurate.
app.put('/api/admin/pml/:id/schedule', adminOnly, (req, res) => {
  const pml = get('SELECT * FROM pml_loans WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!pml) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  run(`UPDATE pml_loans SET payment_day=?, autopay_enabled=?, autopay_method=?, autopay_note=? WHERE id=?`,
    b.payment_day ?? pml.payment_day, b.autopay_enabled ? 1 : 0,
    b.autopay_method || pml.autopay_method || 'bank_transfer',
    b.autopay_note ?? pml.autopay_note, pml.id);
  res.json(get('SELECT * FROM pml_loans WHERE id=?', pml.id));
});

// What is due to lenders, and what is overdue to be recorded.
app.get('/api/admin/pml-due', adminOnly, (req, res) => {
  const rows = all(`SELECT pl.*, p.address FROM pml_loans pl LEFT JOIN properties p ON p.id=pl.property_id
    WHERE pl.company_id=? AND pl.status='active'`, req.companyId);
  const period = today().slice(0, 7);
  const out = rows.map(pl => {
    const paidThisPeriod = get(`SELECT COUNT(*) c FROM pml_ledger
      WHERE pml_loan_id=? AND type='payment' AND substr(entry_date,1,7)=?`, pl.id, period).c > 0;
    const due = loanEngine.nextDueDate(pl, today());
    return {
      id: pl.id, lender_name: pl.lender_name, address: pl.address || '',
      payment_cents: pl.payment_cents, next_due_date: due,
      paid_this_period: paidThisPeriod, autopay_enabled: !!pl.autopay_enabled,
      autopay_method: pl.autopay_method, payment_day: pl.payment_day,
      balance_cents: pl.principal_balance_cents,
    };
  });
  res.json({ period, loans: out, unpaid_count: out.filter(x => !x.paid_this_period).length });
});

// Records payments for lenders you have flagged as autopay — the transfer itself is set up
// at your bank; this keeps the ledger and your reports in step with it.
function runPmlAutoRecord() {
  const period = today().slice(0, 7);
  const day = new Date().getUTCDate();
  const rows = all(`SELECT * FROM pml_loans WHERE status='active' AND autopay_enabled=1`);
  for (const pl of rows) {
    try {
      if (pl.autopay_last_period === period) continue;
      const dueDay = pl.payment_day || Number(String(pl.first_payment_date).slice(8, 10)) || 1;
      if (day < dueDay) continue;
      const already = get(`SELECT COUNT(*) c FROM pml_ledger WHERE pml_loan_id=? AND type='payment'
        AND substr(entry_date,1,7)=?`, pl.id, period).c;
      if (already) { run('UPDATE pml_loans SET autopay_last_period=? WHERE id=?', period, pl.id); continue; }
      const r = pl.interest_rate_bps / 10000 / 12;
      const interestOwed = pl.interest_due_cents || Math.round(pl.principal_balance_cents * r);
      const amount = pl.payment_cents;
      const toInterest = Math.min(amount, interestOwed);
      const toPrincipal = Math.min(amount - toInterest, pl.principal_balance_cents);
      const newBal = pl.principal_balance_cents - toPrincipal;
      run(`INSERT INTO pml_ledger (pml_loan_id, entry_date, type, amount_cents, to_interest_cents,
            to_principal_cents, principal_balance_after_cents, memo)
           VALUES (?,?,?,?,?,?,?,?)`, pl.id, today(), 'payment', amount, toInterest, toPrincipal,
        newBal, `Scheduled payment ${period}`);
      run(`UPDATE pml_loans SET principal_balance_cents=?, interest_due_cents=?, autopay_last_period=?,
            status=CASE WHEN ?<=0 THEN 'paid_off' ELSE status END WHERE id=?`,
        newBal, Math.max(0, interestOwed - toInterest), period, newBal, pl.id);
      console.log(`Recorded scheduled lender payment for ${pl.lender_name} ${period}`);
    } catch (e) { console.error('PML auto-record failed for', pl.id, e.message); }
  }
}
setInterval(runPmlAutoRecord, 6 * 60 * 60 * 1000);
setTimeout(runPmlAutoRecord, 25000);
app.post('/api/admin/pml-auto-record', adminOnly, (req, res) => { runPmlAutoRecord(); res.json({ ok: true }); });

app.post('/api/admin/pml/:id/draw', adminOnly, (req, res) => {
  const pml = get('SELECT * FROM pml_loans WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!pml) return res.status(404).json({ error: 'Not found' });
  const amount = Number(req.body.amount_cents);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount required' });
  const newBal = pml.principal_balance_cents + amount;
  run(`INSERT INTO pml_ledger (pml_loan_id, entry_date, type, amount_cents, principal_balance_after_cents, memo, created_by)
       VALUES (?,?,?,?,?,?,?)`, pml.id, req.body.entry_date || today(), 'draw', amount, newBal, req.body.memo || 'Additional draw', req.user.id);
  run('UPDATE pml_loans SET principal_balance_cents=? WHERE id=?', newBal, pml.id);
  res.json({ balance_cents: newBal });
});

// ---------- notices ----------
app.get('/api/admin/loans/:id/notices', adminOnly, (req, res) => {
  if (!ownedLoan(req, req.params.id)) return res.status(404).json({ error: 'Loan not found' });
  res.json(all('SELECT * FROM notices WHERE loan_id=? ORDER BY id DESC', req.params.id));
});
app.post('/api/admin/loans/:id/notices', adminOnly, (req, res) => {
  const { subject, body } = req.body || {};
  if (!ownedLoan(req, req.params.id)) return res.status(404).json({ error: 'Loan not found' });
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body required' });
  const co = get('SELECT * FROM companies WHERE id=?', req.companyId);
  const html = tpl.brandedShell({ company: co, subject,
    bodyHtml: String(body).split('\n\n').map(par => `<p>${tpl.escapeHtml(par)}</p>`).join(''),
    baseUrl: baseUrlOf(req) });
  run('INSERT INTO notices (loan_id, type, subject, body, body_html) VALUES (?,?,?,?,?)',
    req.params.id, 'custom', subject, body, html);
  run('INSERT INTO messages (loan_id, sender_user_id, body, read_by_admin) VALUES (?,?,?,1)',
    req.params.id, req.user.id, `📄 ${subject} — open the Notices section on your Home screen to read this notice.`);
  res.json({ ok: true });
});
app.post('/api/admin/notice-sweep', adminOnly, (req, res) => { runNoticeSweep(); res.json({ ok: true }); });
app.get('/api/tenant/notices', tenantReady, (req, res) => {
  const loan = get('SELECT * FROM loans WHERE tenant_user_id=? ORDER BY id DESC LIMIT 1', req.user.id);
  if (!loan) return res.json([]);
  res.json(all('SELECT * FROM notices WHERE loan_id=? ORDER BY id DESC', loan.id));
});
app.post('/api/tenant/notices/:id/read', tenantReady, (req, res) => {
  const loan = get('SELECT * FROM loans WHERE tenant_user_id=? ORDER BY id DESC LIMIT 1', req.user.id);
  if (!loan) return res.status(404).json({ error: 'No loan' });
  run("UPDATE notices SET read_at=datetime('now') WHERE id=? AND loan_id=? AND read_at IS NULL", req.params.id, loan.id);
  res.json({ ok: true });
});

// ---------- processing fees ----------
// The buyer's loan is always credited the full payment amount; the fee rides on top of the
// charge and covers the processor. Cash at retail already charges the buyer at the register,
// so we add nothing there.
function feeSettings(companyId) {
  const c = get('SELECT * FROM companies WHERE id=?', companyId) || {};
  return {
    pass: c.pass_fees_to_buyer === undefined ? 1 : c.pass_fees_to_buyer,
    label: c.fee_label || 'Processing fee',
    card_bps: c.fee_card_bps ?? 290, card_fixed: c.fee_card_fixed_cents ?? 30,
    ach_bps: c.fee_ach_bps ?? 80, ach_fixed: c.fee_ach_fixed_cents ?? 0,
    ach_cap: c.fee_ach_cap_cents ?? 500,
  };
}
// method: 'card' | 'cashapp' | 'ach' | 'cash'
function calcFee(companyId, amountCents, method) {
  const f = feeSettings(companyId);
  if (!f.pass || method === 'cash') return 0;
  if (method === 'ach') {
    const raw = Math.round(amountCents * f.ach_bps / 10000) + f.ach_fixed;
    return f.ach_cap ? Math.min(raw, f.ach_cap) : raw;
  }
  return Math.round(amountCents * f.card_bps / 10000) + f.card_fixed;
}
app.get('/api/tenant/fee-quote', tenantReady, (req, res) => {
  const loan = tenantLoan(req);
  if (!loan) return res.status(404).json({ error: 'No loan' });
  const amount = Number(req.query.amount_cents) || 0;
  const f = feeSettings(loan.company_id);
  res.json({
    pass_fees: !!f.pass, label: f.label, amount_cents: amount,
    card: { fee_cents: calcFee(loan.company_id, amount, 'card'), total_cents: amount + calcFee(loan.company_id, amount, 'card') },
    cashapp: { fee_cents: calcFee(loan.company_id, amount, 'cashapp'), total_cents: amount + calcFee(loan.company_id, amount, 'cashapp') },
    ach: { fee_cents: calcFee(loan.company_id, amount, 'ach'), total_cents: amount + calcFee(loan.company_id, amount, 'ach') },
    cash: { fee_cents: 0, total_cents: amount, note: 'The store charges its own fee at the register.' },
  });
});

// ---------- saved payment methods (tokenized via Stripe) ----------
function customerFor(user) {
  return pay.getOrCreateCustomer(user, (id) =>
    run('UPDATE users SET stripe_customer_id=? WHERE id=?', id, user.id));
}
function baseUrlOf(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return process.env.BASE_URL || `${proto}://${req.headers.host}`;
}

app.get('/api/tenant/payment-methods', tenantReady, (req, res) => {
  res.json(all(`SELECT id, type, brand, last4, exp_month, exp_year, is_default
    FROM payment_methods WHERE user_id=? ORDER BY is_default DESC, id DESC`, req.user.id));
});

// Opens Stripe Checkout in "setup" mode — Stripe collects and stores the card/bank.
app.post('/api/tenant/payment-methods/setup', tenantReady, async (req, res, next) => {
  if (!pay.stripeEnabled()) return res.status(400).json({ error: 'Online payments are not enabled yet. Ask your servicer.' });
  try {
    const customerId = await customerFor(req.user);
    const session = await pay.createSetupSession({ customerId, baseUrl: baseUrlOf(req) });
    res.json({ url: session.url });
  } catch (e) { next(e); }
});

// Called after the redirect back — pulls the saved method into our table.
app.get('/api/tenant/payment-methods/confirm', tenantReady, async (req, res, next) => {
  if (!pay.stripeEnabled()) return res.json({ ok: false });
  try {
    const sess = await pay.retrieveSession(req.query.setup_session);
    if (!sess.setup_intent) return res.json({ ok: false });
    const si = await pay.retrieveSetupIntent(
      typeof sess.setup_intent === 'string' ? sess.setup_intent : sess.setup_intent.id);
    if (!si.payment_method) return res.json({ ok: false });
    const pm = await pay.retrievePaymentMethod(
      typeof si.payment_method === 'string' ? si.payment_method : si.payment_method.id);
    savePaymentMethod(req.user.id, si.customer, pm);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

function savePaymentMethod(userId, customerId, pm) {
  if (get('SELECT id FROM payment_methods WHERE stripe_payment_method_id=?', pm.id)) return;
  const isCard = pm.type === 'card';
  const d = isCard ? pm.card : pm.us_bank_account;
  const hasDefault = get('SELECT id FROM payment_methods WHERE user_id=? AND is_default=1', userId);
  run(`INSERT INTO payment_methods (user_id, stripe_customer_id, stripe_payment_method_id,
        type, brand, last4, exp_month, exp_year, is_default) VALUES (?,?,?,?,?,?,?,?,?)`,
    userId, customerId, pm.id, pm.type,
    isCard ? (d && d.brand) : (d && d.bank_name),
    d && d.last4, isCard && d ? d.exp_month : null, isCard && d ? d.exp_year : null,
    hasDefault ? 0 : 1);
}

app.post('/api/tenant/payment-methods/:id/default', tenantReady, (req, res) => {
  const pm = get('SELECT * FROM payment_methods WHERE id=? AND user_id=?', req.params.id, req.user.id);
  if (!pm) return res.status(404).json({ error: 'Not found' });
  run('UPDATE payment_methods SET is_default=0 WHERE user_id=?', req.user.id);
  run('UPDATE payment_methods SET is_default=1 WHERE id=?', pm.id);
  res.json({ ok: true });
});

app.delete('/api/tenant/payment-methods/:id', tenantReady, async (req, res, next) => {
  const pm = get('SELECT * FROM payment_methods WHERE id=? AND user_id=?', req.params.id, req.user.id);
  if (!pm) return res.status(404).json({ error: 'Not found' });
  const loan = tenantLoan(req);
  const ap = loan ? get('SELECT * FROM autopay WHERE loan_id=?', loan.id) : null;
  if (ap && ap.payment_method_id === pm.id && ap.enabled) {
    return res.status(400).json({ error: 'This method is used for autopay. Turn autopay off first, or switch it to another method.' });
  }
  try { if (pay.stripeEnabled()) await pay.detachPaymentMethod(pm.stripe_payment_method_id); } catch {}
  run('DELETE FROM payment_methods WHERE id=?', pm.id);
  if (pm.is_default) {
    const next_ = get('SELECT id FROM payment_methods WHERE user_id=? ORDER BY id LIMIT 1', req.user.id);
    if (next_) run('UPDATE payment_methods SET is_default=1 WHERE id=?', next_.id);
  }
  res.json({ ok: true });
});

// One-tap payment with a stored method (buyer present).
app.post('/api/tenant/pay/saved', tenantReady, async (req, res, next) => {
  const loan = tenantLoan(req);
  if (!loan) return res.status(404).json({ error: 'No loan' });
  if (!pay.stripeEnabled()) return res.status(400).json({ error: 'Online payments are not enabled yet.' });
  const amount = Number(req.body.amount_cents);
  const pm = get('SELECT * FROM payment_methods WHERE id=? AND user_id=?', req.body.payment_method_id, req.user.id);
  if (!pm) return res.status(404).json({ error: 'Payment method not found' });
  if (!amount || amount < 100) return res.status(400).json({ error: 'Enter a valid amount' });
  try {
    const feeKind = pm.type === 'card' ? 'card' : 'ach';
    const fee = calcFee(loan.company_id, amount, feeKind);
    const pi = await pay.chargeSavedMethod({
      customerId: pm.stripe_customer_id, paymentMethodId: pm.stripe_payment_method_id,
      amountCents: amount + fee, description: `Loan payment — loan #${loan.id}`,
      idempotencyKey: `pay-${loan.id}-${Date.now()}`,
    });
    if (pi.status === 'succeeded' || pi.status === 'processing') {
      const method = pm.type === 'card' ? 'stripe_card' : 'stripe_ach';
      postPayment(loan.id, amount, method, today(), `stripe:${pi.id}`,
        pi.status === 'processing' ? 'Bank payment — clearing' : 'Saved method payment', null, fee);
      return res.json({ ok: true, status: pi.status, fee_cents: fee });
    }
    res.status(400).json({ error: 'Payment could not be completed. Try another method.' });
  } catch (e) { next(e); }
});

// ---------- autopay ----------
app.get('/api/tenant/autopay', tenantReady, (req, res) => {
  const loan = tenantLoan(req);
  if (!loan) return res.json({ enabled: false });
  const ap = get('SELECT * FROM autopay WHERE loan_id=?', loan.id);
  if (!ap) return res.json({ enabled: false });
  const pm = get('SELECT id, type, brand, last4 FROM payment_methods WHERE id=?', ap.payment_method_id);
  res.json({ ...ap, enabled: !!ap.enabled, payment_method: pm });
});
app.post('/api/tenant/autopay', tenantReady, (req, res) => {
  const loan = tenantLoan(req);
  if (!loan) return res.status(404).json({ error: 'No loan' });
  const { payment_method_id, amount_mode, fixed_amount_cents, extra_principal_cents, days_before_due } = req.body || {};
  const pm = get('SELECT * FROM payment_methods WHERE id=? AND user_id=?', payment_method_id, req.user.id);
  if (!pm) return res.status(400).json({ error: 'Choose a saved payment method first' });
  run(`INSERT INTO autopay (loan_id, payment_method_id, enabled, amount_mode, fixed_amount_cents,
        extra_principal_cents, days_before_due) VALUES (?,?,1,?,?,?,?)
       ON CONFLICT(loan_id) DO UPDATE SET payment_method_id=excluded.payment_method_id, enabled=1,
        amount_mode=excluded.amount_mode, fixed_amount_cents=excluded.fixed_amount_cents,
        extra_principal_cents=excluded.extra_principal_cents, days_before_due=excluded.days_before_due,
        last_error=NULL`,
    loan.id, pm.id, amount_mode || 'full', fixed_amount_cents || null,
    extra_principal_cents || 0, days_before_due || 0);
  res.json({ ok: true });
});
app.delete('/api/tenant/autopay', tenantReady, (req, res) => {
  const loan = tenantLoan(req);
  if (loan) run('UPDATE autopay SET enabled=0 WHERE loan_id=?', loan.id);
  res.json({ ok: true });
});

// Daily sweep: charge enrolled loans on/after their due date.
async function runAutopaySweep() {
  if (!pay.stripeEnabled()) return;
  const rows = all(`SELECT a.*, l.id AS loan_id, l.company_id FROM autopay a
    JOIN loans l ON l.id=a.loan_id WHERE a.enabled=1 AND l.status='active'`);
  for (const ap of rows) {
    try {
      let loan = get('SELECT * FROM loans WHERE id=?', ap.loan_id);
      loan = assessRecurringCharges(loan);
      const ledger = all('SELECT * FROM ledger WHERE loan_id=?', loan.id);
      const status = loanEngine.loanStatus(loan, ledger, today());
      const period = today().slice(0, 7);
      if (ap.last_run_period === period) continue;          // already charged this month
      const due = status.owed_now_cents;
      if (due <= 0) continue;                                 // nothing owed yet
      const charges = all('SELECT * FROM charges WHERE loan_id=? AND recurring=1 AND active=1', loan.id)
        .reduce((t, c) => t + c.amount_cents, 0);
      let amount = ap.amount_mode === 'fixed' ? (ap.fixed_amount_cents || 0)
                 : ap.amount_mode === 'minimum' ? Math.min(due, loan.payment_cents + loan.escrow_cents + charges)
                 : due;
      amount += ap.extra_principal_cents || 0;
      if (amount < 100) continue;
      const pm = get('SELECT * FROM payment_methods WHERE id=?', ap.payment_method_id);
      if (!pm) { run('UPDATE autopay SET last_error=? WHERE loan_id=?', 'Saved payment method was removed', loan.id); continue; }
      const fee = calcFee(loan.company_id, amount, pm.type === 'card' ? 'card' : 'ach');
      const pi = await pay.chargeSavedMethod({
        customerId: pm.stripe_customer_id, paymentMethodId: pm.stripe_payment_method_id,
        amountCents: amount + fee, description: `Autopay — loan #${loan.id} ${period}`,
        idempotencyKey: `autopay-${loan.id}-${period}`,
      });
      if (pi.status === 'succeeded' || pi.status === 'processing') {
        postPayment(loan.id, amount, pm.type === 'card' ? 'stripe_card' : 'stripe_ach', today(),
          `stripe:${pi.id}`, `Autopay ${period}`, null, fee);
        run("UPDATE autopay SET last_run_period=?, last_error=NULL WHERE loan_id=?", period, loan.id);
        run('INSERT INTO messages (loan_id, sender_user_id, body, read_by_admin) VALUES (?,?,?,1)',
          loan.id, get("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') ORDER BY id LIMIT 1", loan.company_id).id,
          `✅ Autopay processed your payment of $${(amount/100).toFixed(2)}.`);
        console.log(`Autopay charged loan ${loan.id} ${period}: $${(amount/100).toFixed(2)}`);
      }
    } catch (e) {
      run('UPDATE autopay SET last_error=? WHERE loan_id=?', e.message, ap.loan_id);
      const loan = get('SELECT * FROM loans WHERE id=?', ap.loan_id);
      if (loan) run('INSERT INTO messages (loan_id, sender_user_id, body, read_by_admin) VALUES (?,?,?,1)',
        loan.id, get("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') ORDER BY id LIMIT 1", loan.company_id).id,
        `⚠️ Autopay could not process your payment: ${e.message}. Please make a payment in the app.`);
      console.error('Autopay failed for loan', ap.loan_id, e.message);
    }
  }
}
setInterval(runAutopaySweep, 6 * 60 * 60 * 1000);   // every 6 hours
setTimeout(runAutopaySweep, 20000);
app.post('/api/admin/autopay-sweep', adminOnly, async (req, res, next) => {
  try { await runAutopaySweep(); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---------- payment reminders the admin configures ----------
const DEFAULT_REMINDERS = [
  { name: 'Coming up', offset_days: -5, channel: 'push', only_if_unpaid: 1,
    title: 'Payment due in 5 days',
    body: 'Your payment of {{monthly_payment}} for {{property_address}} is due {{due_date}}.' },
  { name: 'Due today', offset_days: 0, channel: 'both', only_if_unpaid: 1,
    title: 'Payment due today',
    body: 'Your payment of {{amount_due}} is due today. You can pay in the app in under a minute.' },
  { name: 'Past due', offset_days: 5, channel: 'both', only_if_unpaid: 1,
    title: 'Payment past due',
    body: 'We have not received your payment of {{amount_due}} for {{property_address}}. A late fee of {{late_fee}} may apply.' },
];

function seedReminders(companyId) {
  if (get('SELECT COUNT(*) c FROM reminder_rules WHERE company_id=?', companyId).c) return;
  for (const r of DEFAULT_REMINDERS) {
    run(`INSERT INTO reminder_rules (company_id, name, offset_days, title, body, channel, only_if_unpaid)
         VALUES (?,?,?,?,?,?,?)`, companyId, r.name, r.offset_days, r.title, r.body, r.channel, r.only_if_unpaid);
  }
}

app.get('/api/admin/reminders', adminOnly, (req, res) => {
  seedReminders(req.companyId);
  res.json({
    merge_fields: tpl.MERGE_FIELDS,
    rules: all('SELECT * FROM reminder_rules WHERE company_id=? ORDER BY offset_days', req.companyId),
  });
});
app.post('/api/admin/reminders', adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.title || !b.body) return res.status(400).json({ error: 'Name, title and message are required' });
  const r = run(`INSERT INTO reminder_rules (company_id, name, offset_days, title, body, channel, only_if_unpaid, enabled)
    VALUES (?,?,?,?,?,?,?,?)`, req.companyId, b.name, Number(b.offset_days) || 0, b.title, b.body,
    b.channel || 'push', b.only_if_unpaid === false ? 0 : 1, b.enabled === false ? 0 : 1);
  res.json(get('SELECT * FROM reminder_rules WHERE id=?', r.lastInsertRowid));
});
app.put('/api/admin/reminders/:id', adminOnly, (req, res) => {
  const rule = get('SELECT * FROM reminder_rules WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  run(`UPDATE reminder_rules SET name=?, offset_days=?, title=?, body=?, channel=?, enabled=?, only_if_unpaid=? WHERE id=?`,
    b.name ?? rule.name, b.offset_days ?? rule.offset_days, b.title ?? rule.title, b.body ?? rule.body,
    b.channel ?? rule.channel, b.enabled === undefined ? rule.enabled : (b.enabled ? 1 : 0),
    b.only_if_unpaid === undefined ? rule.only_if_unpaid : (b.only_if_unpaid ? 1 : 0), rule.id);
  res.json(get('SELECT * FROM reminder_rules WHERE id=?', rule.id));
});
app.delete('/api/admin/reminders/:id', adminOnly, (req, res) => {
  const rule = get('SELECT * FROM reminder_rules WHERE id=? AND company_id=?', req.params.id, req.companyId);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  run('DELETE FROM reminder_rules WHERE id=?', rule.id);
  res.json({ ok: true });
});

// Send one buyer a reminder right now, from a rule or free text.
app.post('/api/admin/loans/:id/remind', adminOnly, async (req, res, next) => {
  const loan = ownedLoan(req, req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (!loan.tenant_user_id) return res.status(400).json({ error: 'No buyer on this loan yet' });
  try {
    const ctx = mergeContextForLoan(req, loan.id);
    const values = tpl.buildMergeValues(ctx);
    let title = req.body.title, body = req.body.body;
    if (req.body.rule_id) {
      const rule = get('SELECT * FROM reminder_rules WHERE id=? AND company_id=?', req.body.rule_id, req.companyId);
      if (!rule) return res.status(404).json({ error: 'Reminder not found' });
      title = rule.title; body = rule.body;
    }
    if (!title) return res.status(400).json({ error: 'Nothing to send' });
    await notify.notify(loan.tenant_user_id, {
      kind: 'payment_due',
      title: tpl.applyMerge(title, values),
      body: tpl.applyMerge(body || '', values),
      url: '/?tab=pay',
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Daily sweep that fires every enabled rule at its offset from the due date.
async function runReminderSweep() {
  const today_ = today();
  const loans = all("SELECT * FROM loans WHERE status='active' AND tenant_user_id IS NOT NULL");
  for (const raw of loans) {
    try {
      const loan = assessRecurringCharges(raw);
      const ledger = all('SELECT * FROM ledger WHERE loan_id=?', loan.id);
      const status = loanEngine.loanStatus(loan, ledger, today_);
      const due = status.next_due_date || loanEngine.nextDueDate(loan, today_);
      if (!due) continue;
      const rules = all('SELECT * FROM reminder_rules WHERE company_id=? AND enabled=1', loan.company_id);
      if (!rules.length) continue;

      const company = get('SELECT * FROM companies WHERE id=?', loan.company_id);
      const property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
      const buyer = get('SELECT * FROM users WHERE id=?', loan.tenant_user_id);
      if (!buyer || buyer.deleted_at || buyer.archived_at) continue;
      const values = tpl.buildMergeValues({ company, buyer, loan, property, status,
        payoff: loanEngine.payoffQuote(loan, today_), baseUrl: process.env.BASE_URL || '' });

      for (const rule of rules) {
        // The day this rule wants to fire, relative to the due date.
        const fireOn = new Date(new Date(due + 'T00:00:00Z').getTime() + rule.offset_days * 86400000)
          .toISOString().slice(0, 10);
        if (fireOn !== today_) continue;
        if (rule.only_if_unpaid && status.owed_now_cents <= 0 && rule.offset_days >= 0) continue;

        const title = tpl.applyMerge(rule.title, values);
        const body = tpl.applyMerge(rule.body, values);
        const dedupe = `rule:${rule.id}:${due}`;

        if (rule.channel === 'push' || rule.channel === 'both') {
          await notify.notify(loan.tenant_user_id, { kind: rule.offset_days > 0 ? 'payment_late' : 'payment_due',
            title, body, url: '/?tab=pay', dedupeKey: dedupe });
        }
        if (rule.channel === 'message' || rule.channel === 'both') {
          const already = get("SELECT id FROM messages WHERE loan_id=? AND subject=? AND date(created_at)=?",
            loan.id, title, today_);
          if (!already) {
            const html = tpl.brandedShell({ company, subject: title,
              bodyHtml: `<p>${tpl.escapeHtml(body)}</p>`, baseUrl: process.env.BASE_URL || '' });
            const sender = get("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') AND deleted_at IS NULL ORDER BY id LIMIT 1", loan.company_id);
            if (sender) run(`INSERT INTO messages (loan_id, sender_user_id, body, body_html, subject, read_by_admin)
              VALUES (?,?,?,?,?,1)`, loan.id, sender.id, body, html, title);
          }
        }
      }
    } catch (e) { console.error('Reminder sweep failed for loan', raw.id, e.message); }
  }
}
setInterval(runReminderSweep, 6 * 60 * 60 * 1000);
setTimeout(runReminderSweep, 30000);
app.post('/api/admin/reminder-sweep', adminOnly, async (req, res, next) => {
  try { await runReminderSweep(); res.json({ ok: true }); } catch (e) { next(e); }
});

// ---------- notifications ----------
app.get('/api/push/public-key', anyUser, (req, res) => res.json({ key: notify.vapid().publicKey }));
app.post('/api/push/subscribe', anyUser, (req, res, next) => {
  try { notify.subscribe(req.user.id, req.body.subscription); res.json({ ok: true }); }
  catch (e) { next(e); }
});
app.post('/api/push/unsubscribe', anyUser, (req, res) => {
  if (req.body.endpoint) notify.unsubscribe(req.body.endpoint);
  res.json({ ok: true });
});
app.get('/api/notifications', anyUser, (req, res) => {
  res.json({ counts: notify.unreadCount(req.user.id), items: notify.list(req.user.id) });
});
app.post('/api/notifications/read', anyUser, (req, res) => {
  notify.markRead(req.user.id, { id: req.body.id, kind: req.body.kind });
  res.json({ counts: notify.unreadCount(req.user.id) });
});
app.get('/api/notifications/prefs', anyUser, (req, res) => res.json(notify.prefsFor(req.user.id)));
app.post('/api/notifications/prefs', anyUser, (req, res) => {
  notify.setPrefs(req.user.id, req.body || {});
  res.json(notify.prefsFor(req.user.id));
});

// ---------- consent: terms, privacy, messaging, location ----------
// Apple 5.1.1 and Google Play both require clear consent before collecting personal data,
// and Play requires a prominent disclosure before any location permission prompt.
function logConsent(req, kind, version) {
  run('INSERT INTO consents (user_id, kind, version, ip, user_agent) VALUES (?,?,?,?,?)',
    req.user.id, kind, version || null,
    (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
    (req.headers['user-agent'] || '').slice(0, 300));
}
app.get('/api/terms-version', (req, res) => res.json({ version: TERMS_VERSION }));
app.post('/api/tenant/accept-terms', tenantOnly, (req, res) => {
  if (!req.body.accept_terms || !req.body.accept_privacy) {
    return res.status(400).json({ error: 'You must accept both the Terms of Use and the Privacy Policy to continue.' });
  }
  run("UPDATE users SET terms_accepted_at=datetime('now'), terms_version=? WHERE id=?", TERMS_VERSION, req.user.id);
  logConsent(req, 'terms', TERMS_VERSION);
  logConsent(req, 'privacy', TERMS_VERSION);
  logConsent(req, 'messaging', TERMS_VERSION);   // in-app messaging + electronic notices
  res.json({ ok: true, terms_version: TERMS_VERSION });
});
app.get('/api/tenant/consents', tenantOnly, (req, res) => {
  res.json({
    terms_accepted_at: req.user.terms_accepted_at,
    terms_version: req.user.terms_version,
    current_version: TERMS_VERSION,
    location_consent_at: req.user.location_consent_at,
    history: all('SELECT kind, version, created_at FROM consents WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id),
  });
});

// ---------- account: data export & deletion (App Store 5.1.1(v) / Play Data deletion) ----------
app.get('/api/account/export', anyUser, (req, res) => {
  const u = get('SELECT id, name, email, phone, role, created_at, terms_accepted_at, terms_version FROM users WHERE id=?', req.user.id);
  const out = { account: u, exported_at: new Date().toISOString() };
  if (req.user.role === 'tenant') {
    const loan = get('SELECT * FROM loans WHERE tenant_user_id=? ORDER BY id DESC LIMIT 1', req.user.id);
    if (loan) {
      out.loan = loan;
      out.property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
      out.payment_history = all('SELECT * FROM ledger WHERE loan_id=? ORDER BY id', loan.id);
      out.messages = all('SELECT body, created_at, sender_user_id FROM messages WHERE loan_id=? ORDER BY id', loan.id);
      out.notices = all('SELECT type, subject, body, sent_at, read_at FROM notices WHERE loan_id=? ORDER BY id', loan.id);
      out.documents = all('SELECT filename, category, created_at FROM documents WHERE loan_id=? AND visible_to_tenant=1', loan.id);
    }
  }
  out.consent_history = all('SELECT kind, version, created_at FROM consents WHERE user_id=? ORDER BY id', req.user.id);
  out.location_history = all('SELECT lat, lng, created_at FROM location_pings WHERE user_id=? ORDER BY id', req.user.id);
  res.setHeader('Content-Disposition', 'attachment; filename="my-data-export.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(out, null, 2));
});

// Erase a user's personal data. Ledger entries, notices, and messages reference the user
// row by foreign key and carry legal retention duties, so the row is kept as an anonymized
// tombstone: every piece of personal information is overwritten, the login is destroyed,
// and the account can never be signed into again. Runs as one transaction so a failure
// can't leave the account half-erased.
function eraseUser(uid, role) {
  const tomb = `deleted-${crypto.randomUUID()}@deleted.invalid`;
  db.exec('BEGIN');
  try {
    run('DELETE FROM location_pings WHERE user_id=?', uid);
    run('DELETE FROM consents WHERE user_id=?', uid);
    run('DELETE FROM notifications WHERE user_id=?', uid);
    run('DELETE FROM push_subscriptions WHERE user_id=?', uid);
    run('UPDATE messages SET body=? WHERE sender_user_id=?', '[message removed at user request]', uid);
    if (role === 'tenant') run('UPDATE loans SET tenant_user_id=NULL WHERE tenant_user_id=?', uid);
    run(`UPDATE users SET email=?, name='Deleted user', phone=NULL,
           password_hash=?, must_change_password=0, location_consent_at=NULL,
           terms_accepted_at=NULL, terms_version=NULL, deleted_at=datetime('now')
         WHERE id=?`, tomb, hashPassword(crypto.randomUUID()), uid);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

app.post('/api/account/delete', anyUser, (req, res, next) => {
  if (req.body.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' });
  if (req.user.role === 'owner') {
    return res.status(400).json({ error: 'Company owners cannot self-delete. Transfer ownership or contact support.' });
  }
  try {
    eraseUser(req.user.id, req.user.role);
    res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
    res.json({ ok: true, message: 'Your account and personal data have been deleted.' });
  } catch (e) { next(e); }
});

// ---------- tenant routes ----------
function tenantLoan(req) {
  return get('SELECT * FROM loans WHERE tenant_user_id=? ORDER BY id DESC LIMIT 1', req.user.id);
}
app.get('/api/tenant/loan', tenantReady, (req, res) => {
  const loan = tenantLoan(req);
  if (!loan) return res.status(404).json({ error: 'No loan is linked to your account yet. Contact your servicer.' });
  const f = loanFull(loan);
  f.schedule = loanEngine.amortizationSchedule(loan);
  f.payoff = loanEngine.payoffQuote(f.loan, today());
  f.documents = all('SELECT id, filename, created_at FROM documents WHERE loan_id=? AND visible_to_tenant=1', loan.id);
  f.slips = all("SELECT * FROM cash_slips WHERE loan_id=? AND status='open' ORDER BY id DESC", loan.id);
  f.stripe_enabled = pay.stripeEnabled();
  f.location_consent_at = req.user.location_consent_at;
  f.terms_accepted_at = req.user.terms_accepted_at;
  f.fee_settings = feeSettings(loan.company_id);
  f.autopay = get('SELECT * FROM autopay WHERE loan_id=?', loan.id) || null;
  f.payment_methods = all(`SELECT id, type, brand, last4, exp_month, exp_year, is_default
    FROM payment_methods WHERE user_id=? ORDER BY is_default DESC, id DESC`, req.user.id);
  res.json(f);
});
app.post('/api/tenant/pay/checkout', tenantReady, async (req, res) => {
  const loan = tenantLoan(req);
  if (!loan) return res.status(404).json({ error: 'No loan' });
  if (!pay.stripeEnabled()) return res.status(400).json({ error: 'Online payments are not enabled yet. Ask your servicer.' });
  const amount = Number(req.body.amount_cents);
  if (!amount || amount < 100) return res.status(400).json({ error: 'Enter a valid amount' });
  try {
    const property = get('SELECT * FROM properties WHERE id=?', loan.property_id);
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const baseUrl = process.env.BASE_URL || `${proto}://${req.headers.host}`;
    const fee = calcFee(loan.company_id, amount, 'card');
    const session = await pay.createCheckoutSession({
      loan: { ...loan, address: property ? property.address : 'your home' },
      amountCents: amount, baseUrl, tenantEmail: req.user.email,
      feeCents: fee, feeLabel: feeSettings(loan.company_id).label,
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Confirm after redirect (covers local/dev where webhooks can't reach the server)
app.get('/api/tenant/pay/confirm', tenantReady, async (req, res) => {
  if (!pay.stripeEnabled()) return res.json({ ok: false, reason: 'stripe_not_configured' });
  try {
    const s = await pay.retrieveSession(req.query.session_id);
    if (s.payment_status === 'paid' && s.metadata && Number(s.metadata.loan_id)) {
      const result = postStripePayment(s);
      return res.json({ ok: true, duplicate: !!result.duplicate });
    }
    res.json({ ok: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/tenant/pay/cash-slip', tenantReady, async (req, res) => {
  const loan = tenantLoan(req);
  if (!loan) return res.status(404).json({ error: 'No loan' });
  const amount = Number(req.body.amount_cents);
  if (!amount || amount < 100) return res.status(400).json({ error: 'Enter a valid amount' });
  try {
    const slip = await pay.createRetailSlip(loan.id, amount, req.user);
    res.json(slip);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/tenant/messages', tenantReady, (req, res) => {
  const loan = tenantLoan(req);
  if (!loan) return res.json([]);
  run('UPDATE messages SET read_by_tenant=1 WHERE loan_id=?', loan.id);
  res.json(all('SELECT m.*, u.name AS sender_name, u.role AS sender_role FROM messages m JOIN users u ON u.id=m.sender_user_id WHERE m.loan_id=? ORDER BY m.id', loan.id));
});
app.post('/api/tenant/messages', tenantReady, (req, res) => {
  const loan = tenantLoan(req);
  if (!loan) return res.status(404).json({ error: 'No loan' });
  if (!req.body.body) return res.status(400).json({ error: 'Message required' });
  run('INSERT INTO messages (loan_id, sender_user_id, body, read_by_tenant) VALUES (?,?,?,1)', loan.id, req.user.id, req.body.body);
  const property = get('SELECT address FROM properties WHERE id=?', loan.property_id);
  for (const a of all("SELECT id FROM users WHERE company_id=? AND role IN ('owner','admin') AND deleted_at IS NULL AND archived_at IS NULL", loan.company_id)) {
    notify.notify(a.id, { kind: 'message', title: `${req.user.name} sent a message`,
      body: `${property ? property.address + ' — ' : ''}${String(req.body.body).slice(0, 120)}`,
      url: '/admin' }).catch(() => {});
  }
  res.json({ ok: true });
});

// ---------- location sharing (opt-in with recorded consent) ----------
app.post('/api/tenant/location/consent', tenantReady, (req, res) => {
  if (req.body.consent) {
    run("UPDATE users SET location_consent_at=datetime('now') WHERE id=?", req.user.id);
    logConsent(req, 'location_on', TERMS_VERSION);
  } else {
    run('UPDATE users SET location_consent_at=NULL WHERE id=?', req.user.id);
    run('DELETE FROM location_pings WHERE user_id=?', req.user.id); // revoke deletes history
    logConsent(req, 'location_off', TERMS_VERSION);
  }
  res.json({ ok: true });
});
app.post('/api/tenant/location', tenantReady, (req, res) => {
  const u = get('SELECT location_consent_at FROM users WHERE id=?', req.user.id);
  if (!u.location_consent_at) return res.status(403).json({ error: 'Location sharing not enabled' });
  const { lat, lng, accuracy_m } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat/lng required' });
  run('INSERT INTO location_pings (user_id, lat, lng, accuracy_m) VALUES (?,?,?,?)', req.user.id, lat, lng, accuracy_m || null);
  // keep only latest 50 pings per user
  run('DELETE FROM location_pings WHERE user_id=? AND id NOT IN (SELECT id FROM location_pings WHERE user_id=? ORDER BY id DESC LIMIT 50)', req.user.id, req.user.id);
  res.json({ ok: true });
});
app.get('/api/admin/tenants/:id/location', adminOnly, (req, res) => {
  const u = get("SELECT location_consent_at FROM users WHERE id=? AND company_id=? AND role='tenant'", req.params.id, req.companyId);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const last = get('SELECT * FROM location_pings WHERE user_id=? ORDER BY id DESC LIMIT 1', req.params.id);
  res.json({ consent_at: u.location_consent_at, last_ping: last || null });
});

// ---------- admin: cash slips (mark paid when cash received) ----------
app.get('/api/admin/cash-slips', adminOnly, (req, res) => {
  res.json(all(`SELECT s.*, p.address, u.name AS tenant_name FROM cash_slips s
    JOIN loans l ON l.id=s.loan_id LEFT JOIN properties p ON p.id=l.property_id
    LEFT JOIN users u ON u.id=l.tenant_user_id WHERE l.company_id=? ORDER BY s.id DESC`, req.companyId));
});
app.post('/api/admin/cash-slips/:id/mark-paid', adminOnly, (req, res) => {
  const slip = get(`SELECT s.* FROM cash_slips s JOIN loans l ON l.id=s.loan_id
    WHERE s.id=? AND l.company_id=?`, req.params.id, req.companyId);
  if (!slip || slip.status !== 'open') return res.status(400).json({ error: 'Slip not open' });
  postPayment(slip.loan_id, slip.amount_cents, 'cash_retail', today(), `slip:${slip.slip_code}`, `Cash payment — slip ${slip.slip_code}`, req.user.id);
  run("UPDATE cash_slips SET status='paid', paid_at=datetime('now') WHERE id=?", slip.id);
  res.json({ ok: true });
});

// ---------- pages ----------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/support', (req, res) => res.sendFile(path.join(__dirname, 'public', 'support.html')));
app.get('/delete-account', (req, res) => res.sendFile(path.join(__dirname, 'public', 'delete-account.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tenant.html')));

// Any unhandled route error comes back as JSON so the apps can surface a real message.
app.use((err, req, res, next) => {
  console.error(`${req.method} ${req.path} —`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => console.log(`PorchPay running on port ${PORT}`));
module.exports = app;
