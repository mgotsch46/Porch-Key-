// Payoff quotes.
//
// A payoff letter is not a dashboard figure. Somebody wires money against it, a title
// company closes on it, and if the number is wrong you either eat the difference or
// argue with a buyer who has your letter in their hand. So an issued quote is frozen:
// the breakdown is stored as it was calculated, and regenerating the letter re-renders
// the stored figures rather than recomputing them.
//
// 12 CFR 1026.36(c)(3) gives you seven business days from a written request. There is
// no small-servicer exemption anywhere in 1026.36, so it applies whatever your volume.

const { get, all, run } = require('./db');
const J = require('./journal');

const DAY = 86400000;
const SLA_BUSINESS_DAYS = 7;

const dayCount = (loan) => (loan && loan.day_count === '360' ? 360 : 365);

function addBusinessDays(from, n) {
  const d = new Date(from);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;      // weekends only; holidays are not modelled
  }
  return d;
}

function initSchema() {
  const { db } = require('./db');
  db.exec(`
CREATE TABLE IF NOT EXISTS payoff_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  quote_number TEXT NOT NULL UNIQUE,
  requested_by TEXT NOT NULL DEFAULT 'admin'
    CHECK (requested_by IN ('admin','buyer','title_company','lender','other')),
  requested_by_user_id INTEGER REFERENCES users(id),
  requester_note TEXT,
  request_received_at TEXT NOT NULL,
  sla_due_at TEXT NOT NULL,               -- request + 7 business days
  quote_date TEXT NOT NULL,
  good_through_date TEXT NOT NULL,
  -- every figure that makes up the total, kept as issued
  principal_cents INTEGER NOT NULL,
  interest_to_quote_cents INTEGER NOT NULL,
  per_diem_cents INTEGER NOT NULL,
  forward_days INTEGER NOT NULL,
  forward_interest_cents INTEGER NOT NULL,
  fees_cents INTEGER NOT NULL DEFAULT 0,
  escrow_advance_cents INTEGER NOT NULL DEFAULT 0,
  escrow_credit_cents INTEGER NOT NULL DEFAULT 0,
  suspense_credit_cents INTEGER NOT NULL DEFAULT 0,
  release_fee_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  breakdown_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued'
    CHECK (status IN ('issued','expired','superseded','honored','withdrawn')),
  issued_at TEXT,
  delivered_at TEXT,
  delivery_json TEXT,
  honored_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payoff_loan ON payoff_quotes(loan_id, id);
CREATE INDEX IF NOT EXISTS idx_payoff_open ON payoff_quotes(status, sla_due_at);
`);
}

// ---------- the calculation ----------
// Interest is accrued to the QUOTE date, then per diem carries it forward to the
// good-through date. Accruing to good-through *and* adding per diem on top charges the
// same interest twice — on a $120k note at 9.5% with a 30-day quote that is about $950
// of overcharge on a document somebody is going to rely on.
function calculate(loanId, { goodThroughDate, quoteDate, releaseFeeCents = 0 } = {}) {
  const loan = get('SELECT * FROM loans WHERE id=?', loanId);
  if (!loan) throw new Error('No such loan');

  const qDate = quoteDate || new Date().toISOString().slice(0, 10);
  const gDate = goodThroughDate
    || new Date(new Date(qDate + 'T00:00:00Z').getTime() + 30 * DAY).toISOString().slice(0, 10);
  if (gDate < qDate) throw new Error('The good-through date cannot be before the quote date');

  // The journal is the source of truth where it has an opinion; the loan row is the
  // fallback for a company whose books have not been migrated.
  const jPrincipal = J.balance('1200', { loan_id: loanId });
  const principal = jPrincipal || loan.principal_balance_cents;

  // Interest carried on the account, plus what has accrued since it was last paid to.
  const basis = dayCount(loan);
  const perDiemExact = principal * (loan.interest_rate_bps / 10000) / basis;
  const perDiem = Math.round(perDiemExact);

  const paidTo = loan.interest_paid_to
    || (get('SELECT MAX(entry_date) d FROM ledger WHERE loan_id=? AND type=\'payment\'', loanId) || {}).d
    || loan.first_payment_date;
  const accrualDays = paidTo
    ? Math.max(0, Math.round((new Date(qDate + 'T00:00:00Z') - new Date(paidTo + 'T00:00:00Z')) / DAY))
    : 0;
  // Rounded once at the end rather than per day, so a 30-day quote does not drift.
  const interestToQuote = (loan.interest_due_cents || 0) + Math.round(perDiemExact * accrualDays);

  const forwardDays = Math.max(0,
    Math.round((new Date(gDate + 'T00:00:00Z') - new Date(qDate + 'T00:00:00Z')) / DAY));
  const forwardInterest = Math.round(perDiemExact * forwardDays);

  const fees = J.balance('1250', { loan_id: loanId }) || loan.fees_due_cents || 0;
  const escrowAdvance = J.balance('1260', { loan_id: loanId }) || 0;   // you fronted this
  const escrowCredit = J.balance('2100', { loan_id: loanId }) || loan.escrow_balance_cents || 0;
  const suspense = J.balance('2150', { loan_id: loanId }) || 0;

  const total = principal + interestToQuote + forwardInterest + fees
    + escrowAdvance + releaseFeeCents - escrowCredit - suspense;

  return {
    loan_id: loanId,
    quote_date: qDate,
    good_through_date: gDate,
    principal_cents: principal,
    interest_to_quote_cents: interestToQuote,
    interest_accrual_days: accrualDays,
    interest_paid_to: paidTo,
    per_diem_cents: perDiem,
    forward_days: forwardDays,
    forward_interest_cents: forwardInterest,
    fees_cents: fees,
    escrow_advance_cents: escrowAdvance,
    escrow_credit_cents: escrowCredit,
    suspense_credit_cents: suspense,
    release_fee_cents: releaseFeeCents,
    total_cents: Math.max(0, total),
    day_count_basis: basis,
  };
}

// ---------- issuing ----------
function nextQuoteNumber(companyId) {
  const year = new Date().getFullYear();
  const n = get(`SELECT COUNT(*) c FROM payoff_quotes WHERE company_id=? AND quote_number LIKE ?`,
    companyId, `PO-${year}-%`).c + 1;
  return `PO-${year}-${String(n).padStart(4, '0')}`;
}

function issue(loanId, {
  goodThroughDate, releaseFeeCents = 0, requestedBy = 'admin', requestedByUserId,
  requesterNote, requestReceivedAt, createdBy,
} = {}) {
  const loan = get('SELECT * FROM loans WHERE id=?', loanId);
  if (!loan) throw new Error('No such loan');
  if (loan.status === 'paid_off') throw new Error('This loan is already paid off');

  const calc = calculate(loanId, { goodThroughDate, releaseFeeCents });
  const received = requestReceivedAt || new Date().toISOString();
  const slaDue = addBusinessDays(new Date(received), SLA_BUSINESS_DAYS).toISOString();

  // A newer quote supersedes anything still outstanding, so there is only ever one
  // live number for a loan.
  run(`UPDATE payoff_quotes SET status='superseded' WHERE loan_id=? AND status='issued'`, loanId);

  const number = nextQuoteNumber(loan.company_id);
  const r = run(`INSERT INTO payoff_quotes (loan_id, company_id, quote_number, requested_by,
    requested_by_user_id, requester_note, request_received_at, sla_due_at, quote_date,
    good_through_date, principal_cents, interest_to_quote_cents, per_diem_cents, forward_days,
    forward_interest_cents, fees_cents, escrow_advance_cents, escrow_credit_cents,
    suspense_credit_cents, release_fee_cents, total_cents, breakdown_json, status, issued_at, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'issued',datetime('now'),?)`,
    loanId, loan.company_id, number, requestedBy, requestedByUserId || null,
    requesterNote || null, received, slaDue, calc.quote_date, calc.good_through_date,
    calc.principal_cents, calc.interest_to_quote_cents, calc.per_diem_cents, calc.forward_days,
    calc.forward_interest_cents, calc.fees_cents, calc.escrow_advance_cents,
    calc.escrow_credit_cents, calc.suspense_credit_cents, calc.release_fee_cents,
    calc.total_cents, JSON.stringify(calc), createdBy || null);

  return get('SELECT * FROM payoff_quotes WHERE id=?', r.lastInsertRowid);
}

// Anything past its good-through date is no longer good. Run on the same sweep as notices.
function expireStale() {
  const today = new Date().toISOString().slice(0, 10);
  const r = run(`UPDATE payoff_quotes SET status='expired'
    WHERE status='issued' AND good_through_date < ?`, today);
  return r.changes || 0;
}

// Quotes still open with the seven business days running out.
function slaWatch(companyId) {
  return all(`SELECT q.*, p.address, u.name buyer_name
    FROM payoff_quotes q
    JOIN loans l ON l.id=q.loan_id
    LEFT JOIN properties p ON p.id=l.property_id
    LEFT JOIN users u ON u.id=l.tenant_user_id
    WHERE q.company_id=? AND q.status='issued'
    ORDER BY q.sla_due_at`, companyId);
}

// ---------- the letter ----------
// Lines are only shown when they carry a figure, so a simple payoff reads simply
// rather than as a wall of zeroes.
function letterLines(q) {
  const rows = [
    ['Unpaid principal balance', q.principal_cents],
    ['Interest accrued through ' + q.quote_date, q.interest_to_quote_cents],
    [`Interest ${q.forward_days} day${q.forward_days === 1 ? '' : 's'} to the good-through date`, q.forward_interest_cents],
    ['Outstanding fees', q.fees_cents],
    ['Escrow advanced on your behalf', q.escrow_advance_cents],
    ['Release and recording fee', q.release_fee_cents],
  ].filter(([, v]) => v);
  const credits = [
    ['Escrow balance held for you', -q.escrow_credit_cents],
    ['Unapplied funds on account', -q.suspense_credit_cents],
  ].filter(([, v]) => v);
  return { charges: rows, credits };
}

module.exports = {
  initSchema, calculate, issue, expireStale, slaWatch, letterLines,
  addBusinessDays, nextQuoteNumber, SLA_BUSINESS_DAYS,
};
