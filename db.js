// Database layer — uses Node 22's built-in SQLite (zero native dependencies).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Each servicing company is a fully isolated tenant of the platform.
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_email TEXT,
  contact_phone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id),   -- NULL only for platform super_admin
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin','owner','admin','tenant')),
  name TEXT NOT NULL,
  phone TEXT,
  must_change_password INTEGER DEFAULT 0,
  location_consent_at TEXT,   -- when the buyer opted in to location sharing (NULL = not consented)
  terms_accepted_at TEXT,     -- when they accepted Terms + Privacy (NULL = must accept before use)
  terms_version TEXT,         -- which version they accepted, so changes can re-prompt
  deleted_at TEXT,            -- set when the account is erased; row is kept as an
                              -- anonymized tombstone so ledger/message foreign keys stay valid
  archived_at TEXT,           -- reversible: hidden from active lists, cannot sign in, data intact
  archived_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Audit trail of every consent action (acceptance, location opt-in/out).
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('terms','privacy','messaging','location_on','location_off')),
  version TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS location_pings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy_m REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  address TEXT NOT NULL,
  city TEXT, state TEXT, zip TEXT,
  -- Land trust info
  trust_name TEXT,
  trustee TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  tenant_user_id INTEGER REFERENCES users(id),
  loan_type TEXT NOT NULL DEFAULT 'land_contract'
    CHECK (loan_type IN ('land_contract','land_trust_beneficial_interest')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid_off','default','cancelled')),
  -- Terms (money in cents)
  sale_price_cents INTEGER NOT NULL,
  down_payment_cents INTEGER NOT NULL DEFAULT 0,
  principal_cents INTEGER NOT NULL,          -- original financed amount
  interest_rate_bps INTEGER NOT NULL,        -- annual rate in basis points (e.g. 950 = 9.50%)
  term_months INTEGER NOT NULL,
  payment_cents INTEGER NOT NULL,            -- monthly P&I
  escrow_cents INTEGER NOT NULL DEFAULT 0,   -- monthly escrow (taxes/insurance)
  late_fee_cents INTEGER NOT NULL DEFAULT 0,
  grace_days INTEGER NOT NULL DEFAULT 5,
  first_payment_date TEXT NOT NULL,          -- YYYY-MM-DD
  due_day INTEGER NOT NULL DEFAULT 1,
  -- Running balances (cents)
  principal_balance_cents INTEGER NOT NULL,
  escrow_balance_cents INTEGER NOT NULL DEFAULT 0,
  fees_due_cents INTEGER NOT NULL DEFAULT 0,
  interest_due_cents INTEGER NOT NULL DEFAULT 0, -- accrued unpaid interest carried over
  interest_paid_to TEXT,                     -- date interest is paid through (last posting)
  -- Beneficial interest (for land trust deals)
  beneficial_interest_pct REAL,              -- tenant buyer's beneficial interest %
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  entry_date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('payment','late_fee','fee','adjustment','escrow_disbursement','note')),
  method TEXT,           -- stripe_card | stripe_ach | stripe_cashapp | cash_retail | cash | check | cashapp_manual | zelle | other
  amount_cents INTEGER NOT NULL,             -- total received (positive) or charge (negative for fees assessed)
  to_interest_cents INTEGER DEFAULT 0,
  to_principal_cents INTEGER DEFAULT 0,
  to_escrow_cents INTEGER DEFAULT 0,
  to_fees_cents INTEGER DEFAULT 0,
  principal_balance_after_cents INTEGER,
  memo TEXT,
  external_id TEXT,      -- Stripe session/payment id or retail slip id (idempotency)
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_external ON ledger(external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  sender_user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  read_by_admin INTEGER DEFAULT 0,
  read_by_tenant INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cash_slips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slip_code TEXT UNIQUE NOT NULL,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','expired','cancelled')),
  barcode_url TEXT,
  expires_at TEXT,
  paid_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Additional charges on a loan: one-time or recurring monthly (insurance, HOA, servicing fee...)
CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  description TEXT NOT NULL,
  category TEXT DEFAULT 'other' CHECK (category IN ('taxes','insurance','utilities','servicing_fee','hoa','other')),
  amount_cents INTEGER NOT NULL,
  recurring INTEGER NOT NULL DEFAULT 0,      -- 0 = one-time (assessed immediately as fee), 1 = monthly
  start_date TEXT,
  end_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Document center. category drives the shared folders both parties see;
-- visible_to_tenant = 0 puts a file in the admin-only private vault.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  loan_id INTEGER REFERENCES loans(id),
  property_id INTEGER REFERENCES properties(id),
  kind TEXT NOT NULL DEFAULT 'closing' CHECK (kind IN ('closing','statement','other')),
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('loan_docs','insurance','taxes','utilities','correspondence','statement','private','other')),
  title TEXT,                 -- optional friendly label, e.g. "2026 Homeowners Policy"
  effective_date TEXT,        -- e.g. policy/tax year date, for sorting updates
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT,
  visible_to_tenant INTEGER DEFAULT 0,
  extracted_json TEXT,   -- AI extraction result
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Private money lender (PML) loans — money YOU owe against a property. Admin-only.
CREATE TABLE IF NOT EXISTS pml_loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  lender_name TEXT NOT NULL,
  lender_contact TEXT,
  lien_position INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid_off','default')),
  principal_cents INTEGER NOT NULL,
  interest_rate_bps INTEGER NOT NULL,
  term_months INTEGER NOT NULL,
  payment_type TEXT NOT NULL DEFAULT 'amortized' CHECK (payment_type IN ('amortized','interest_only','balloon')),
  payment_cents INTEGER NOT NULL DEFAULT 0,
  balloon_date TEXT,
  first_payment_date TEXT NOT NULL,
  principal_balance_cents INTEGER NOT NULL,
  interest_due_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pml_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pml_loan_id INTEGER NOT NULL REFERENCES pml_loans(id),
  entry_date TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'payment' CHECK (type IN ('payment','draw','fee','adjustment')),
  amount_cents INTEGER NOT NULL,
  to_interest_cents INTEGER DEFAULT 0,
  to_principal_cents INTEGER DEFAULT 0,
  principal_balance_after_cents INTEGER,
  memo TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Late / legal notices with read receipts
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  type TEXT NOT NULL CHECK (type IN ('late_notice','legal_notice','custom')),
  period TEXT,               -- YYYY-MM of the missed payment (for auto notices)
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TEXT DEFAULT (datetime('now')),
  read_at TEXT,              -- read receipt: set when the buyer opens the notice
  created_at TEXT DEFAULT (datetime('now'))
);

-- Property expenses (from statement imports or manual entry)
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  property_id INTEGER REFERENCES properties(id),  -- NULL until assigned
  document_id INTEGER REFERENCES documents(id),
  txn_date TEXT,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'unassigned' CHECK (status IN ('unassigned','assigned','ignored')),
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---------- migrations (safe to re-run; adds columns to older databases) ----------
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumnIfMissing('documents', 'category', "TEXT NOT NULL DEFAULT 'other'");
addColumnIfMissing('documents', 'title', 'TEXT');
addColumnIfMissing('documents', 'effective_date', 'TEXT');
addColumnIfMissing('cash_slips', 'barcode_url', 'TEXT');
addColumnIfMissing('users', 'location_consent_at', 'TEXT');
addColumnIfMissing('users', 'terms_accepted_at', 'TEXT');
addColumnIfMissing('users', 'terms_version', 'TEXT');
addColumnIfMissing('users', 'deleted_at', 'TEXT');
addColumnIfMissing('users', 'archived_at', 'TEXT');
addColumnIfMissing('users', 'archived_reason', 'TEXT');
addColumnIfMissing('charges', 'category', "TEXT DEFAULT 'other'");
// Multi-company columns for databases created before company support.
for (const t of ['users', 'properties', 'loans', 'pml_loans', 'documents', 'expenses']) {
  addColumnIfMissing(t, 'company_id', 'INTEGER');
}

// Backfill: any pre-existing single-company data joins the first company.
function backfillCompany() {
  const orphan = get('SELECT COUNT(*) c FROM properties WHERE company_id IS NULL').c
    + get('SELECT COUNT(*) c FROM loans WHERE company_id IS NULL').c;
  if (!orphan) return;
  let firstCo = get('SELECT id FROM companies ORDER BY id LIMIT 1');
  if (!firstCo) {
    const r = run('INSERT INTO companies (name) VALUES (?)', process.env.COMPANY_NAME || 'My Company');
    firstCo = { id: r.lastInsertRowid };
  }
  for (const t of ['properties', 'loans', 'pml_loans', 'documents', 'expenses']) {
    run(`UPDATE ${t} SET company_id=? WHERE company_id IS NULL`, firstCo.id);
  }
  run("UPDATE users SET company_id=? WHERE company_id IS NULL AND role<>'super_admin'", firstCo.id);
  console.log(`Migrated existing data into company #${firstCo.id}`);
}

CREATE_INDEXES();
function CREATE_INDEXES() {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_props_co ON properties(company_id);
    CREATE INDEX IF NOT EXISTS idx_loans_co ON loans(company_id);
    CREATE INDEX IF NOT EXISTS idx_pml_co ON pml_loans(company_id);
    CREATE INDEX IF NOT EXISTS idx_docs_co ON documents(company_id);
    CREATE INDEX IF NOT EXISTS idx_exp_co ON expenses(company_id);
    CREATE INDEX IF NOT EXISTS idx_users_co ON users(company_id);
  `);
}

// ---------- helpers ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(pw, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function get(sql, ...params) { return db.prepare(sql).get(...params); }
function all(sql, ...params) { return db.prepare(sql).all(...params); }
function run(sql, ...params) { return db.prepare(sql).run(...params); }

// Seed the first company + owner, and the platform super admin.
function ensureSeed() {
  backfillCompany();
  if (get('SELECT COUNT(*) AS c FROM users').c === 0) {
    const coName = process.env.COMPANY_NAME || 'My Company';
    const r = run('INSERT INTO companies (name, contact_email) VALUES (?,?)', coName, process.env.ADMIN_EMAIL || null);
    const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
    const pw = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
    run('INSERT INTO users (company_id, email, password_hash, role, name, must_change_password) VALUES (?,?,?,?,?,1)',
      r.lastInsertRowid, email, hashPassword(pw), 'owner', 'Administrator');
    console.log(`Seeded company "${coName}" with owner ${email} / ${pw} — change this password after first login.`);
  }
  // Optional platform super admin, only created when explicitly configured.
  if (process.env.SUPERADMIN_EMAIL && process.env.SUPERADMIN_PASSWORD) {
    const em = process.env.SUPERADMIN_EMAIL.toLowerCase();
    if (!get('SELECT id FROM users WHERE email=?', em)) {
      run('INSERT INTO users (company_id, email, password_hash, role, name) VALUES (NULL,?,?,?,?)',
        em, hashPassword(process.env.SUPERADMIN_PASSWORD), 'super_admin', 'Platform Admin');
      console.log(`Seeded platform super admin: ${em}`);
    }
  }
}
ensureSeed();

module.exports = { db, get, all, run, hashPassword, verifyPassword };
