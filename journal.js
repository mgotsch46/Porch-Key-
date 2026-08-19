// Double-entry journal.
//
// Today the money lives in four tables that do not talk to each other — ledger (what
// the tenant buyer pays you), pml_ledger (what you pay your lender), property_costs
// (what the house cost you) and expenses (what it costs to hold). Each screen SUMs a
// different combination, which is why no two screens ever quite agree, and why there
// is no honest answer to "what is my actual spread on this house".
//
// This is the one place money is recorded. Every entry names the property, so the
// property ledger is a query rather than a feature. Every entry balances, so the books
// cannot drift. Nothing is ever updated or deleted — a mistake is corrected with a
// reversing entry, because the history is the point.
//
// Two funds. Operating money is yours. Trust money — escrow you hold for a buyer's
// taxes and insurance — is not, and each fund must balance on its own so a dollar can
// never quietly cross from one to the other.

const { db, get, all, run } = require('./db');

// ---------- chart of accounts ----------
// code, name, type, fund. Seeded once; safe to re-run.
const ACCOUNTS = [
  // assets
  ['1010', 'Operating Cash',              'asset',     'operating'],
  ['1015', 'Trust Cash — Escrow',         'asset',     'trust'],
  ['1200', 'Notes Receivable — Buyer',    'asset',     'operating'],
  ['1210', 'Interest Receivable — Buyer', 'asset',     'operating'],
  ['1250', 'Late Fees Receivable',        'asset',     'operating'],
  ['1260', 'Escrow Advances Receivable',  'asset',     'operating'],
  ['1400', 'Property Basis',              'asset',     'operating'],
  // liabilities
  ['2100', 'Escrow Held for Buyer',       'liability', 'trust'],
  ['2150', 'Unapplied Funds',             'liability', 'operating'],
  ['2200', 'PML Note Payable',            'liability', 'operating'],
  ['2210', 'PML Interest Payable',        'liability', 'operating'],
  // equity
  ['3000', 'Owner Equity',                'equity',    'operating'],
  // revenue
  ['4100', 'Interest Income — Buyer',     'revenue',   'operating'],
  ['4200', 'Late Fee Income',             'revenue',   'operating'],
  ['4300', 'Servicing Fee Income',        'revenue',   'operating'],
  ['4400', 'Gain on Sale',                'revenue',   'operating'],
  // expenses
  ['5100', 'PML Interest Expense',        'expense',   'operating'],
  ['5200', 'Property Taxes',              'expense',   'operating'],
  ['5210', 'Insurance',                   'expense',   'operating'],
  ['5220', 'Repairs & Maintenance',       'expense',   'operating'],
  ['5230', 'Utilities',                   'expense',   'operating'],
  ['5240', 'Legal & Professional',        'expense',   'operating'],
  ['5250', 'Marketing',                   'expense',   'operating'],
  ['5260', 'Filing & Recording',          'expense',   'operating'],
  ['5270', 'Processing Fees',             'expense',   'operating'],
  ['5900', 'Other Expense',               'expense',   'operating'],
];

// Normal balance by type: which side increases the account.
const DEBIT_POSITIVE = new Set(['asset', 'expense']);

function initSchema() {
  db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  fund TEXT NOT NULL DEFAULT 'operating' CHECK (fund IN ('operating','trust')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  entry_date TEXT NOT NULL,               -- YYYY-MM-DD, the accounting date
  description TEXT NOT NULL,
  source_type TEXT NOT NULL,              -- payment | accrual | pml_payment | cost |
                                          -- expense | escrow_disbursement | fee |
                                          -- opening_balance | manual | reversal
  source_id INTEGER,                      -- row id in the originating table, if any
  property_id INTEGER REFERENCES properties(id),
  loan_id INTEGER REFERENCES loans(id),
  pml_loan_id INTEGER REFERENCES pml_loans(id),
  idempotency_key TEXT UNIQUE,            -- stops a retried webhook posting twice
  reverses_id INTEGER REFERENCES journal_entries(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  line_no INTEGER NOT NULL,
  account_code TEXT NOT NULL REFERENCES accounts(code),
  debit_cents INTEGER NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  property_id INTEGER REFERENCES properties(id),
  loan_id INTEGER REFERENCES loans(id),
  pml_loan_id INTEGER REFERENCES pml_loans(id),
  beneficiary_user_id INTEGER REFERENCES users(id),   -- required on trust accounts
  memo TEXT,
  -- exactly one side carries a value, and it is never zero on both
  CHECK ((debit_cents = 0) <> (credit_cents = 0)),
  UNIQUE (entry_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_jl_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_jl_prop ON journal_lines(property_id, account_code);
CREATE INDEX IF NOT EXISTS idx_jl_loan ON journal_lines(loan_id, account_code);
CREATE INDEX IF NOT EXISTS idx_jl_pml ON journal_lines(pml_loan_id, account_code);
CREATE INDEX IF NOT EXISTS idx_jl_acct ON journal_lines(account_code);
CREATE INDEX IF NOT EXISTS idx_je_prop_date ON journal_entries(property_id, entry_date, id);
CREATE INDEX IF NOT EXISTS idx_je_company ON journal_entries(company_id, entry_date);
`);

  const ins = db.prepare(
    'INSERT OR IGNORE INTO accounts (code,name,type,fund) VALUES (?,?,?,?)');
  for (const a of ACCOUNTS) ins.run(...a);
}

const accountCache = new Map();
function account(code) {
  if (!accountCache.has(code)) accountCache.set(code, get('SELECT * FROM accounts WHERE code=?', code));
  const a = accountCache.get(code);
  if (!a) throw new Error(`Unknown account ${code}`);
  return a;
}

// ---------- posting ----------
// The only way money gets written down. Everything else calls this.
//
// lines: [{ account, debit|credit, property_id, loan_id, pml_loan_id,
//           beneficiary_user_id, memo }]
function postEntry({ company_id, date, description, source_type, source_id,
                     property_id, loan_id, pml_loan_id, idempotency_key,
                     reverses_id, created_by, lines }) {
  if (!company_id) throw new Error('An entry must belong to a company');
  if (!date) throw new Error('An entry must have a date');
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error('An entry needs at least two lines — that is what makes it balance');
  }

  if (idempotency_key) {
    const dupe = get('SELECT id FROM journal_entries WHERE idempotency_key=?', idempotency_key);
    if (dupe) return { id: dupe.id, duplicate: true };   // replayed webhook; already recorded
  }

  // ---- validate before writing anything ----
  let totalDr = 0, totalCr = 0;
  const byFund = {};
  const prepared = lines.map((l, i) => {
    const acct = account(l.account);
    const dr = Math.round(l.debit || 0);
    const cr = Math.round(l.credit || 0);
    if (dr < 0 || cr < 0) throw new Error(`Line ${i + 1}: amounts cannot be negative`);
    if ((dr === 0) === (cr === 0)) {
      throw new Error(`Line ${i + 1}: put an amount on exactly one side, debit or credit`);
    }
    if (acct.fund === 'trust' && !l.beneficiary_user_id) {
      throw new Error(`Line ${i + 1}: ${acct.code} is trust money — it must name whose money it is`);
    }
    totalDr += dr; totalCr += cr;
    byFund[acct.fund] = (byFund[acct.fund] || 0) + dr - cr;
    return { ...l, acct, dr, cr, line_no: i + 1 };
  });

  if (totalDr !== totalCr) {
    throw new Error(`Entry does not balance: debits ${totalDr} vs credits ${totalCr}`);
  }
  if (totalDr === 0) throw new Error('An entry cannot be for nothing');
  for (const [fund, delta] of Object.entries(byFund)) {
    if (delta !== 0) {
      throw new Error(`The ${fund} side does not balance on its own (off by ${delta}). ` +
        'Trust and operating money must each balance, or a dollar has crossed between them.');
    }
  }

  // ---- trust may never go negative for any one person ----
  for (const p of prepared) {
    if (p.acct.fund !== 'trust' || !p.beneficiary_user_id) continue;
    const delta = DEBIT_POSITIVE.has(p.acct.type) ? p.dr - p.cr : p.cr - p.dr;
    if (delta >= 0) continue;
    const held = beneficiaryBalance(p.acct.code, p.beneficiary_user_id);
    if (held + delta < 0) {
      throw new Error(
        `That would spend more of this buyer's escrow than is being held for them ` +
        `(holding ${held}, entry takes ${-delta}). Fund the advance first.`);
    }
  }

  // SAVEPOINT rather than BEGIN, so posting an entry from inside a larger transaction
  // (a payment that also updates the loan, say) does not blow up on a nested BEGIN.
  const sp = 'je_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const r = run(`INSERT INTO journal_entries
      (company_id, entry_date, description, source_type, source_id, property_id,
       loan_id, pml_loan_id, idempotency_key, reverses_id, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      company_id, date, description || '', source_type || 'manual', source_id || null,
      property_id || null, loan_id || null, pml_loan_id || null,
      idempotency_key || null, reverses_id || null, created_by || null);
    const entryId = r.lastInsertRowid;

    for (const p of prepared) {
      run(`INSERT INTO journal_lines
        (entry_id, line_no, account_code, debit_cents, credit_cents, property_id,
         loan_id, pml_loan_id, beneficiary_user_id, memo)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        entryId, p.line_no, p.acct.code, p.dr, p.cr,
        p.property_id !== undefined ? p.property_id : (property_id || null),
        p.loan_id !== undefined ? p.loan_id : (loan_id || null),
        p.pml_loan_id !== undefined ? p.pml_loan_id : (pml_loan_id || null),
        p.beneficiary_user_id || null, p.memo || null);
    }
    db.exec(`RELEASE ${sp}`);
    return { id: entryId, duplicate: false };
  } catch (e) {
    try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
    throw e;
  }
}

// Corrections are new entries, not edits. The original stays exactly as it was.
function reverseEntry(entryId, { created_by, reason } = {}) {
  const orig = get('SELECT * FROM journal_entries WHERE id=?', entryId);
  if (!orig) throw new Error('No such entry');
  if (get('SELECT id FROM journal_entries WHERE reverses_id=?', entryId)) {
    throw new Error('That entry has already been reversed');
  }
  const lines = all('SELECT * FROM journal_lines WHERE entry_id=? ORDER BY line_no', entryId);
  return postEntry({
    company_id: orig.company_id,
    date: new Date().toISOString().slice(0, 10),
    description: `Reversal — ${orig.description}${reason ? ` (${reason})` : ''}`,
    source_type: 'reversal', source_id: orig.id,
    property_id: orig.property_id, loan_id: orig.loan_id, pml_loan_id: orig.pml_loan_id,
    reverses_id: orig.id, created_by,
    lines: lines.map(l => ({
      account: l.account_code,
      debit: l.credit_cents, credit: l.debit_cents,   // flipped
      property_id: l.property_id, loan_id: l.loan_id, pml_loan_id: l.pml_loan_id,
      beneficiary_user_id: l.beneficiary_user_id, memo: l.memo,
    })),
  });
}

// ---------- balances ----------
// Signed by normal balance, so an asset reads positive when you hold more of it and a
// liability reads positive when you owe more.
function signed(type, dr, cr) {
  return DEBIT_POSITIVE.has(type) ? (dr - cr) : (cr - dr);
}

function balance(code, where = {}) {
  const a = account(code);
  const cond = ['jl.account_code = ?']; const args = [code];
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined || v === null) continue;
    // company_id and the date live on the entry; everything else on the line.
    if (k === 'as_of')          { cond.push('je.entry_date <= ?'); args.push(v); }
    else if (k === 'company_id'){ cond.push('je.company_id = ?');  args.push(v); }
    else                        { cond.push(`jl.${k} = ?`);        args.push(v); }
  }
  const r = get(`SELECT COALESCE(SUM(jl.debit_cents),0) dr, COALESCE(SUM(jl.credit_cents),0) cr
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE ${cond.join(' AND ')}`, ...args);
  return signed(a.type, r.dr, r.cr);
}

function beneficiaryBalance(code, userId) {
  return balance(code, { beneficiary_user_id: userId });
}

// What a single house has actually done: owed to you, owed by you, and the gap.
function propertySummary(propertyId) {
  const b = (code) => balance(code, { property_id: propertyId });
  const tbPrincipal   = b('1200');
  const tbInterestDue = b('1210');
  const pmlPrincipal  = b('2200');
  const pmlInterestDue= b('2210');
  const interestIn    = b('4100') + b('4200') + b('4300');
  const interestOut   = b('5100');
  const expenses = ['5200','5210','5220','5230','5240','5250','5260','5270','5900']
    .reduce((s, c) => s + b(c), 0);
  return {
    property_id: propertyId,
    basis_cents: b('1400'),
    tb_principal_cents: tbPrincipal,
    tb_interest_due_cents: tbInterestDue,
    escrow_held_cents: b('2100'),
    escrow_advanced_cents: b('1260'),
    pml_principal_cents: pmlPrincipal,
    pml_interest_due_cents: pmlInterestDue,
    // The number the whole business turns on: what the buyer pays you in interest
    // versus what you pay your lender for the same house.
    income_cents: interestIn,
    interest_expense_cents: interestOut,
    other_expense_cents: expenses,
    net_spread_cents: interestIn - interestOut - expenses,
    equity_cents: tbPrincipal - pmlPrincipal,
  };
}

// Every line touching a house, oldest first, with a running balance per account type.
function propertyLedger(propertyId, { from, to, limit } = {}) {
  const cond = ['jl.property_id = ?']; const args = [propertyId];
  if (from) { cond.push('je.entry_date >= ?'); args.push(from); }
  if (to)   { cond.push('je.entry_date <= ?'); args.push(to); }
  const rows = all(`
    SELECT je.id entry_id, je.entry_date, je.description, je.source_type,
           je.loan_id, je.pml_loan_id, je.reverses_id,
           jl.id line_id, jl.line_no, jl.account_code, a.name account_name,
           a.type account_type, a.fund,
           jl.debit_cents, jl.credit_cents, jl.memo
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN accounts a ON a.code = jl.account_code
    WHERE ${cond.join(' AND ')}
    ORDER BY je.entry_date, je.id, jl.line_no
    ${limit ? 'LIMIT ' + Number(limit) : ''}`, ...args);

  const running = {};
  for (const r of rows) {
    const d = signed(r.account_type, r.debit_cents, r.credit_cents);
    running[r.account_code] = (running[r.account_code] || 0) + d;
    r.running_balance_cents = running[r.account_code];
  }
  return rows;
}

// A whole-book check. If this is ever non-zero the books are broken and every
// number downstream is a guess.
function trialBalance(companyId) {
  const r = get(`SELECT COALESCE(SUM(jl.debit_cents),0) dr, COALESCE(SUM(jl.credit_cents),0) cr
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE je.company_id = ?`, companyId);
  const funds = all(`SELECT a.fund,
      COALESCE(SUM(jl.debit_cents),0) dr, COALESCE(SUM(jl.credit_cents),0) cr
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN accounts a ON a.code = jl.account_code
    WHERE je.company_id = ? GROUP BY a.fund`, companyId);
  return {
    debits_cents: r.dr, credits_cents: r.cr, difference_cents: r.dr - r.cr,
    balanced: r.dr === r.cr,
    funds: funds.map(f => ({ fund: f.fund, difference_cents: f.dr - f.cr, balanced: f.dr === f.cr })),
  };
}

// Trust cash on hand must equal the sum of what is held for each person.
function trustCheck(companyId) {
  const cash = balance('1015', { company_id: companyId });
  const perBeneficiary = all(`
    SELECT jl.beneficiary_user_id uid,
           COALESCE(SUM(jl.credit_cents),0) - COALESCE(SUM(jl.debit_cents),0) held
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code = '2100' AND je.company_id = ?
    GROUP BY jl.beneficiary_user_id`, companyId);
  const sumHeld = perBeneficiary.reduce((s, r) => s + r.held, 0);
  const negatives = perBeneficiary.filter(r => r.held < 0);
  return {
    trust_cash_cents: cash,
    escrow_owed_cents: sumHeld,
    balanced: cash === sumHeld,
    negative_beneficiaries: negatives,
  };
}

module.exports = {
  initSchema, ACCOUNTS, account, postEntry, reverseEntry,
  balance, beneficiaryBalance, propertySummary, propertyLedger,
  trialBalance, trustCheck, signed, DEBIT_POSITIVE,
};
