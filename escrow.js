// Escrow: what is being collected, what it has to pay for, and whether it will stretch.
//
// Escrow money is not yours. It is the buyer's money, held so their taxes and insurance
// get paid, and it lives in the trust side of the journal with the buyer's name on it.
//
// The analysis below is aggregate accounting — the method Reg X requires (12 CFR
// 1024.17(c)(4); single-item accounting is prohibited). You project every bill across
// the coming twelve months, run the balance forward month by month, find the lowest
// point it reaches, and compare that to the cushion you are allowed to hold. The gap
// is the shortage or the surplus.
//
// The cushion is a CEILING, not a target: no more than one sixth of the year's
// disbursements, which is two months (1024.17(c)(1)). You may hold less.

const { get, all, run } = require('./db');
const J = require('./journal');

const CUSHION_MAX_MONTHS = 2;
const SURPLUS_REFUND_FLOOR_CENTS = 5000;   // $50 — refund at or above this (1024.17(f)(2))

function initSchema() {
  const { db } = require('./db');
  db.exec(`
-- What this loan escrows for, and when each bill falls due.
CREATE TABLE IF NOT EXISTS escrow_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  item_type TEXT NOT NULL DEFAULT 'property_tax'
    CHECK (item_type IN ('property_tax','hazard_insurance','flood_insurance','hoa','other')),
  payee TEXT,
  account_number TEXT,
  annual_amount_cents INTEGER NOT NULL,
  due_months TEXT NOT NULL,            -- CSV of months, e.g. "2,8" for February and August
  next_due_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_escrow_items_loan ON escrow_items(loan_id, active);

-- One run of the analysis. Kept, because the statement you sent the buyer has to be
-- reproducible a year later.
CREATE TABLE IF NOT EXISTS escrow_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  analysis_date TEXT NOT NULL,
  year_start TEXT NOT NULL,
  year_end TEXT NOT NULL,
  starting_balance_cents INTEGER NOT NULL,
  annual_disbursements_cents INTEGER NOT NULL,
  cushion_months REAL NOT NULL DEFAULT 2,
  required_low_point_cents INTEGER NOT NULL,
  projected_low_point_cents INTEGER NOT NULL,
  surplus_cents INTEGER NOT NULL DEFAULT 0,
  shortage_cents INTEGER NOT NULL DEFAULT 0,
  deficiency_cents INTEGER NOT NULL DEFAULT 0,
  old_monthly_cents INTEGER NOT NULL,
  new_monthly_cents INTEGER NOT NULL,
  repayment_months INTEGER,
  projection_json TEXT,                -- the month-by-month table, for the statement
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_escrow_an_loan ON escrow_analyses(loan_id, id);

-- A bill: scheduled, then paid. A disbursement cannot be marked paid without a receipt,
-- because the receipt is the thing a buyer will eventually ask you for.
CREATE TABLE IF NOT EXISTS escrow_disbursements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  escrow_item_id INTEGER REFERENCES escrow_items(id),
  scheduled_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','paid','skipped','failed')),
  paid_date TEXT,
  payee TEXT,
  method TEXT,
  confirmation TEXT,
  receipt_document_id INTEGER REFERENCES documents(id),
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  advanced_cents INTEGER NOT NULL DEFAULT 0,   -- what you fronted because escrow was short
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_escrow_disb_loan ON escrow_disbursements(loan_id, scheduled_date);
`);
}

const monthsOf = (csv) => String(csv || '').split(',')
  .map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= 12);

// ---------- the analysis ----------
// Returns the whole working, not just the answer, so the statement can show its work.
function analyze(loanId, { asOf, cushionMonths = CUSHION_MAX_MONTHS } = {}) {
  const loan = get('SELECT * FROM loans WHERE id=?', loanId);
  if (!loan) throw new Error('No such loan');
  const items = all('SELECT * FROM escrow_items WHERE loan_id=? AND active=1', loanId);

  const start = asOf ? new Date(asOf + 'T00:00:00Z') : new Date();
  const yearStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const yearEnd = new Date(Date.UTC(yearStart.getUTCFullYear() + 1, yearStart.getUTCMonth(), 0));

  const annual = items.reduce((s, i) => s + i.annual_amount_cents, 0);
  // Bills land in the months you named; a yearly bill split over two months pays half each.
  const monthly = new Array(12).fill(0);
  for (const it of items) {
    const ms = monthsOf(it.due_months);
    if (!ms.length) continue;
    const each = Math.round(it.annual_amount_cents / ms.length);
    for (const m of ms) {
      const offset = (m - 1 - yearStart.getUTCMonth() + 12) % 12;
      monthly[offset] += each;
    }
  }

  const openingBalance = J.balance('2100', { loan_id: loanId });
  const trialPayment = Math.ceil(annual / 12);

  // Run the year forward at the trial payment and see how low it goes.
  const project = (payment, opening) => {
    const rows = []; let bal = opening;
    for (let m = 0; m < 12; m++) {
      const d = new Date(Date.UTC(yearStart.getUTCFullYear(), yearStart.getUTCMonth() + m, 1));
      const inAmt = payment, outAmt = monthly[m];
      bal = bal + inAmt - outAmt;
      rows.push({ month: d.toISOString().slice(0, 7), deposit_cents: inAmt,
                  disbursement_cents: outAmt, balance_cents: bal });
    }
    return rows;
  };

  const trial = project(trialPayment, openingBalance);
  const lowPoint = Math.min(...trial.map(r => r.balance_cents));
  const cushion = Math.min(cushionMonths, CUSHION_MAX_MONTHS);
  const requiredLow = Math.round(trialPayment * cushion);

  let surplus = 0, shortage = 0, deficiency = 0;
  if (openingBalance < 0) {
    // The account is actually overdrawn — money you advanced on the buyer's behalf.
    deficiency = -openingBalance;
  } else if (lowPoint > requiredLow) {
    surplus = lowPoint - requiredLow;
  } else if (lowPoint < requiredLow) {
    shortage = requiredLow - lowPoint;
  }

  // 1024.17(f)(3): a shortage of one month or more may only be spread over at least
  // twelve months — there is no lump-sum option for it. Twelve months is always allowed
  // and never disadvantages the buyer, so that is what this does.
  const repaymentMonths = (shortage || deficiency) ? 12 : null;
  const makeUp = repaymentMonths ? Math.ceil((shortage + deficiency) / repaymentMonths) : 0;
  const newMonthly = trialPayment + makeUp;

  return {
    loan_id: loanId,
    analysis_date: (asOf || new Date().toISOString().slice(0, 10)),
    year_start: yearStart.toISOString().slice(0, 10),
    year_end: yearEnd.toISOString().slice(0, 10),
    items,
    starting_balance_cents: openingBalance,
    annual_disbursements_cents: annual,
    trial_payment_cents: trialPayment,
    cushion_months: cushion,
    required_low_point_cents: requiredLow,
    projected_low_point_cents: lowPoint,
    surplus_cents: surplus,
    shortage_cents: shortage,
    deficiency_cents: deficiency,
    // Below the $50 floor you may refund or credit; at or above it, refund within 30 days.
    surplus_action: surplus >= SURPLUS_REFUND_FLOOR_CENTS ? 'refund_within_30_days'
                  : surplus > 0 ? 'refund_or_credit' : null,
    repayment_months: repaymentMonths,
    shortage_makeup_cents: makeUp,
    old_monthly_cents: loan.escrow_cents || 0,
    new_monthly_cents: newMonthly,
    projection: project(newMonthly, openingBalance),
  };
}

function saveAnalysis(a) {
  const r = run(`INSERT INTO escrow_analyses (loan_id, analysis_date, year_start, year_end,
    starting_balance_cents, annual_disbursements_cents, cushion_months, required_low_point_cents,
    projected_low_point_cents, surplus_cents, shortage_cents, deficiency_cents,
    old_monthly_cents, new_monthly_cents, repayment_months, projection_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    a.loan_id, a.analysis_date, a.year_start, a.year_end, a.starting_balance_cents,
    a.annual_disbursements_cents, a.cushion_months, a.required_low_point_cents,
    a.projected_low_point_cents, a.surplus_cents, a.shortage_cents, a.deficiency_cents,
    a.old_monthly_cents, a.new_monthly_cents, a.repayment_months,
    JSON.stringify(a.projection));
  return r.lastInsertRowid;
}

// ---------- scheduling ----------
// Twelve months of bills laid out ahead, so nothing arrives as a surprise.
function rebuildSchedule(loanId) {
  const items = all('SELECT * FROM escrow_items WHERE loan_id=? AND active=1', loanId);
  const now = new Date();
  let made = 0;
  for (const it of items) {
    const ms = monthsOf(it.due_months);
    if (!ms.length) continue;
    const each = Math.round(it.annual_amount_cents / ms.length);
    for (let ahead = 0; ahead < 12; ahead++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ahead, 1));
      if (!ms.includes(d.getUTCMonth() + 1)) continue;
      const date = d.toISOString().slice(0, 10);
      const exists = get(`SELECT id FROM escrow_disbursements
        WHERE loan_id=? AND escrow_item_id=? AND scheduled_date=?`, loanId, it.id, date);
      if (exists) continue;
      run(`INSERT INTO escrow_disbursements (loan_id, escrow_item_id, scheduled_date,
        amount_cents, payee) VALUES (?,?,?,?,?)`, loanId, it.id, date, each, it.payee || null);
      made++;
    }
  }
  return made;
}

// ---------- paying a bill ----------
// If escrow is short, the difference is advanced from operating rather than driving the
// buyer's trust balance negative — you cannot spend money you are not holding. The
// advance sits as a receivable and comes back through the next analysis.
function payDisbursement(disbId, { paid_date, method, confirmation,
                                   receipt_document_id, created_by, amount_cents } = {}) {
  const d = get('SELECT * FROM escrow_disbursements WHERE id=?', disbId);
  if (!d) throw new Error('No such disbursement');
  if (d.status === 'paid') throw new Error('That bill is already marked paid');
  if (!receipt_document_id) {
    throw new Error('Attach the receipt before marking it paid — it is what the buyer will ask you for');
  }
  const loan = get('SELECT * FROM loans WHERE id=?', d.loan_id);
  const prop = get('SELECT * FROM properties WHERE id=?', loan.property_id);
  const buyer = loan.tenant_user_id;
  if (!buyer) throw new Error('This loan has no buyer, so there is no escrow to draw on');

  const amount = amount_cents != null ? Math.round(amount_cents) : d.amount_cents;
  const date = paid_date || new Date().toISOString().slice(0, 10);
  const held = J.balance('2100', { loan_id: d.loan_id, beneficiary_user_id: buyer });
  const advance = Math.max(0, amount - held);

  const base = { company_id: loan.company_id, property_id: loan.property_id,
                 loan_id: d.loan_id, created_by, date };

  // Fund the shortfall first, so the buyer's escrow never goes below zero.
  if (advance > 0) {
    J.postEntry({
      ...base, source_type: 'escrow_disbursement', source_id: d.id,
      idempotency_key: `escrow:advance:${d.id}`,
      description: `Advanced to cover ${d.payee || 'escrow bill'} — ${prop ? prop.address : ''}`.trim(),
      lines: [
        { account: '1015', debit: advance, beneficiary_user_id: buyer },
        { account: '2100', credit: advance, beneficiary_user_id: buyer },
        { account: '1260', debit: advance },
        { account: '1010', credit: advance },
      ],
    });
  }

  const entry = J.postEntry({
    ...base, source_type: 'escrow_disbursement', source_id: d.id,
    idempotency_key: `escrow:disb:${d.id}`,
    description: `${d.payee || 'Escrow disbursement'} — ${prop ? prop.address : ''}`.trim(),
    lines: [
      { account: '2100', debit: amount, beneficiary_user_id: buyer },
      { account: '1015', credit: amount, beneficiary_user_id: buyer },
    ],
  });

  run(`UPDATE escrow_disbursements SET status='paid', paid_date=?, method=?, confirmation=?,
       receipt_document_id=?, journal_entry_id=?, amount_cents=?, advanced_cents=? WHERE id=?`,
    date, method || null, confirmation || null, receipt_document_id,
    entry.id, amount, advance, d.id);

  run('UPDATE loans SET escrow_balance_cents=? WHERE id=?',
    J.balance('2100', { loan_id: d.loan_id }), d.loan_id);

  return { disbursement_id: d.id, journal_entry_id: entry.id, advanced_cents: advance };
}

// Bills coming up that the projected balance will not cover. Under 1024.17(k)(2) you
// still have to pay them while the buyer is no more than 30 days late — this is a
// warning to get funds ready, not permission to let a tax bill lapse.
function upcomingShortfalls(companyId, daysAhead = 45) {
  const cutoff = new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
  const rows = all(`SELECT d.*, l.company_id, l.tenant_user_id, p.address
    FROM escrow_disbursements d
    JOIN loans l ON l.id = d.loan_id
    LEFT JOIN properties p ON p.id = l.property_id
    WHERE d.status='scheduled' AND d.scheduled_date <= ? AND l.company_id = ?
    ORDER BY d.scheduled_date`, cutoff, companyId);
  return rows.map(r => {
    const held = J.balance('2100', { loan_id: r.loan_id });
    return { ...r, escrow_held_cents: held, short_by_cents: Math.max(0, r.amount_cents - held) };
  }).filter(r => r.short_by_cents > 0);
}

// ---------- getting ready for a bill ----------
// A tax bill you find out about on the day is a scramble; one you saw three weeks out is
// an errand. So every bill that is coming gets a task fifteen working days ahead of it,
// which is roughly three weeks of actual time to find the money, check the amount and
// get it paid.
const PREP_WORKING_DAYS = 15;

function subtractBusinessDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;        // weekends only; holidays are not modelled
  }
  return d.toISOString().slice(0, 10);
}

// Idempotent: every generated task carries a key derived from what it came from, so
// running this repeatedly changes nothing. A task somebody has already ticked off is
// left alone rather than resurrected.
function syncPrepTasks(companyId, { workingDays = PREP_WORKING_DAYS } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
  let made = 0;

  const ensure = ({ key, propertyId, loanId, title, notes, dueDate, category }) => {
    if (dueDate < today) return;                     // no point in a task for last week
    if (get('SELECT id FROM tasks WHERE source_key=?', key)) return;
    run(`INSERT INTO tasks (company_id, property_id, loan_id, title, notes, category,
      priority, due_date, remind_days_before, source_key)
      VALUES (?,?,?,?,?,?,'high',?,3,?)`,
      companyId, propertyId || null, loanId || null, title, notes, category, dueDate, key);
    made++;
  };

  // Bills the escrow schedule already knows about.
  const disbs = all(`SELECT d.*, l.property_id, l.company_id, p.address, ei.item_type
    FROM escrow_disbursements d
    JOIN loans l ON l.id = d.loan_id
    LEFT JOIN properties p ON p.id = l.property_id
    LEFT JOIN escrow_items ei ON ei.id = d.escrow_item_id
    WHERE l.company_id=? AND d.status='scheduled' AND d.scheduled_date <= ?`,
    companyId, horizon);

  for (const d of disbs) {
    const what = d.item_type === 'hazard_insurance' ? 'Insurance'
      : d.item_type === 'flood_insurance' ? 'Flood insurance'
      : d.item_type === 'hoa' ? 'HOA dues' : 'Property tax';
    ensure({
      key: `escrow_disb:${d.id}`,
      propertyId: d.property_id, loanId: d.loan_id,
      title: `${what} due ${d.scheduled_date} — ${d.address || 'property'}`,
      notes: `$${(d.amount_cents / 100).toFixed(2)}${d.payee ? ` to ${d.payee}` : ''}. ` +
        `Paid from the buyer's escrow — check the balance covers it before the due date.`,
      dueDate: subtractBusinessDays(d.scheduled_date, workingDays),
      category: d.item_type === 'property_tax' ? 'taxes' : 'insurance',
    });
  }

  // And the dates recorded straight on a property, for houses with no escrow set up.
  const props = all(`SELECT id, address, tax_due_date, tax_due_date2, insurance_expires, insurance_carrier
    FROM properties WHERE company_id=? AND archived_at IS NULL`, companyId);
  for (const p of props) {
    for (const taxDate of [p.tax_due_date, p.tax_due_date2]) {
      if (taxDate && taxDate <= horizon) {
        ensure({
          key: `prop_tax:${p.id}:${taxDate}`, propertyId: p.id,
          title: `Property tax due ${taxDate} — ${p.address}`,
          notes: 'Recorded on the property. Confirm the amount with the county before paying.',
          dueDate: subtractBusinessDays(taxDate, workingDays), category: 'taxes',
        });
      }
    }
    if (p.insurance_expires && p.insurance_expires <= horizon) {
      ensure({
        key: `prop_ins:${p.id}:${p.insurance_expires}`, propertyId: p.id,
        title: `Insurance renews ${p.insurance_expires} — ${p.address}`,
        notes: `${p.insurance_carrier ? p.insurance_carrier + '. ' : ''}Renew or re-shop before it lapses. ` +
          'An uninsured house is the one thing on this list that cannot be fixed afterwards.',
        dueDate: subtractBusinessDays(p.insurance_expires, workingDays), category: 'insurance',
      });
    }
  }
  return made;
}

module.exports = {
  initSchema, analyze, saveAnalysis, rebuildSchedule, payDisbursement,
  upcomingShortfalls, monthsOf, syncPrepTasks, subtractBusinessDays,
  CUSHION_MAX_MONTHS, SURPLUS_REFUND_FLOOR_CENTS, PREP_WORKING_DAYS,
};
