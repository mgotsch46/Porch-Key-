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
    CHECK (loan_type IN ('agreement_for_deed','land_contract','land_trust_beneficial_interest')),
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
  method TEXT,           -- stripe_card | stripe_ach | stripe_cashapp        (through Stripe)
                         -- cash | check | zelle | venmo | applepay | paypal | other  (recorded by hand)
                         -- cash_retail | cashapp_manual                         (retired, old rows only)
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

-- RETIRED. Cash-at-retail through PayNearMe was removed; nothing reads or writes this
-- any more. The table stays because dropping it in SQLite cannot be undone, and if a
-- buyer ever did pay cash against a code, that record should outlive the feature.
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
    CHECK (category IN ('loan_docs','acquisition','pml_docs','sale_closing','trust_docs','closing_receipts',
      'insurance','taxes','utilities','correspondence','statement','private','unsorted',
      'misc_shared','misc_admin','other')),
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

-- Money spent acquiring and holding a property, before any buyer exists.
-- Rolls up into the cost basis you compare against the sale price.
CREATE TABLE IF NOT EXISTS property_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN
    ('purchase','closing','filing','rehab','bog','lawncare','birddog','insurance','taxes','utilities','marketing','legal','other')),
  description TEXT NOT NULL,
  vendor TEXT,
  amount_cents INTEGER NOT NULL,
  cost_date TEXT,
  document_id INTEGER REFERENCES documents(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Invitations texted to a tenant buyer once the home is sold to them.
CREATE TABLE IF NOT EXISTS invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  loan_id INTEGER REFERENCES loans(id),
  user_id INTEGER REFERENCES users(id),
  phone TEXT,
  temp_password TEXT,
  channel TEXT NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms','manual','email')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','accepted')),
  error TEXT,
  sent_at TEXT,
  accepted_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Saved payment methods. We never store card or bank numbers — only Stripe tokens
-- plus the display crumbs Stripe returns (brand, last4) so the buyer can tell them apart.
CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  stripe_customer_id TEXT NOT NULL,
  stripe_payment_method_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,               -- card | us_bank_account
  brand TEXT,                       -- visa, mastercard, or bank name
  last4 TEXT,
  exp_month INTEGER, exp_year INTEGER,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Autopay enrollment, per loan. Buyer opts in; admin can see but not enable it for them.
CREATE TABLE IF NOT EXISTS autopay (
  loan_id INTEGER PRIMARY KEY REFERENCES loans(id),
  payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Defaults to the regular monthly payment, not everything owed. Drafting arrears and
  -- late fees in one go is how a buyer gets an NSF and a returned ACH on the same day.
  amount_mode TEXT NOT NULL DEFAULT 'minimum' CHECK (amount_mode IN ('full','minimum','fixed')),
  charge_day INTEGER NOT NULL DEFAULT 1,
  fixed_amount_cents INTEGER,
  extra_principal_cents INTEGER NOT NULL DEFAULT 0,
  days_before_due INTEGER NOT NULL DEFAULT 0,
  last_run_period TEXT,             -- YYYY-MM of the last successful charge
  last_error TEXT,
  enrolled_at TEXT DEFAULT (datetime('now'))
);

-- Business bank / credit card accounts the admin links for expense import.
CREATE TABLE IF NOT EXISTS linked_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  stripe_account_id TEXT NOT NULL UNIQUE,   -- Financial Connections account id
  institution_name TEXT,
  display_name TEXT,
  last4 TEXT,
  category TEXT,                    -- checking | savings | credit_card
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disconnected')),
  last_synced_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- In-app notification feed. Badge counts read from here, so a notification is never
-- lost just because a push failed to deliver.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'general',
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  dedupe_key TEXT,          -- stops the same reminder firing twice in a period
  read_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Every outbound email, sent or failed. For a late notice the record that it went out
-- — and from which address — is part of the file, so failures are kept too rather than
-- disappearing into the server log.
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id),
  loan_id INTEGER REFERENCES loans(id),
  identity TEXT NOT NULL DEFAULT 'servicing' CHECK (identity IN ('servicing','legal')),
  to_address TEXT NOT NULL,
  from_address TEXT,
  subject TEXT,
  kind TEXT,                 -- late_notice | legal_notice | statement | receipt | general
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed')),
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Where a notification goes when the app came from a store rather than a browser.
--
-- Web push and native push are different transports for the same thing. A browser or
-- an installed PWA hands over a subscription endpoint, encrypted with VAPID keys, and
-- push_subscriptions above holds it. A Capacitor app cannot use that at all — iOS
-- restricts web push to Safari's own home-screen apps and Android's WebView does not
-- expose the API — so the native shells register an APNs or FCM device token instead
-- and it lives here.
--
-- One person can have several: a phone from the App Store, a tablet from Play, and the
-- web app on a laptop. A notification goes to all of them.
CREATE TABLE IF NOT EXISTS device_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('ios','android')),
  app TEXT NOT NULL DEFAULT 'buyer' CHECK (app IN ('buyer','admin')),
  device_name TEXT,
  last_seen_at TEXT DEFAULT (datetime('now')),
  failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

-- Payment reminder rules. The admin decides when they fire and what they say.
-- offset_days is relative to the due date: -3 means three days before, +5 means five after.
CREATE TABLE IF NOT EXISTS reminder_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  offset_days INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'push' CHECK (channel IN ('push','message','both')),
  enabled INTEGER NOT NULL DEFAULT 1,
  only_if_unpaid INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Reusable HTML message templates, per company.
CREATE TABLE IF NOT EXISTS message_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  subject TEXT,
  body_html TEXT NOT NULL,
  is_starter INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
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
addColumnIfMissing('users', 'notify_prefs', 'TEXT');
addColumnIfMissing('users', 'stripe_customer_id', 'TEXT');
addColumnIfMissing('companies', 'setup_complete', 'INTEGER DEFAULT 0');
addColumnIfMissing('companies', 'logo_path', 'TEXT');
addColumnIfMissing('companies', 'default_late_fee_cents', 'INTEGER DEFAULT 0');
addColumnIfMissing('companies', 'default_grace_days', 'INTEGER DEFAULT 5');
// Processing fees passed on to the buyer. Defaults mirror Stripe's published rates so the
// pass-through is cost recovery, not a markup. Set pass_fees_to_buyer=0 to absorb them.
addColumnIfMissing('companies', 'pass_fees_to_buyer', 'INTEGER DEFAULT 1');
addColumnIfMissing('companies', 'fee_card_bps', 'INTEGER DEFAULT 290');
addColumnIfMissing('companies', 'fee_card_fixed_cents', 'INTEGER DEFAULT 30');
addColumnIfMissing('companies', 'fee_ach_bps', 'INTEGER DEFAULT 80');
addColumnIfMissing('companies', 'fee_ach_fixed_cents', 'INTEGER DEFAULT 0');
addColumnIfMissing('companies', 'fee_ach_cap_cents', 'INTEGER DEFAULT 500');
addColumnIfMissing('companies', 'fee_label', "TEXT DEFAULT 'Processing fee'");
// Prefilled into every new deal so you are not retyping the same contact each time.
// Always editable per deal.
addColumnIfMissing('companies', 'default_buyer_email', 'TEXT');
addColumnIfMissing('companies', 'default_buyer_phone', 'TEXT');
// The management company and the person buyers actually deal with. Prefilled onto
// every property and used on all correspondence; overridable per property.
// Texting credentials live per company: each servicer uses their own number and pays
// their own carrier bill. Environment variables still work as a platform-wide default.
addColumnIfMissing('companies', 'twilio_sid', 'TEXT');
addColumnIfMissing('companies', 'twilio_token', 'TEXT');
addColumnIfMissing('companies', 'twilio_from', 'TEXT');
// The browser softphone. An API key pair signs the access tokens the browser uses,
// and the TwiML app tells Twilio to ask our server what to do with an outgoing call.
addColumnIfMissing('companies', 'voice_api_key_sid', 'TEXT');
addColumnIfMissing('companies', 'voice_api_key_secret', 'TEXT');
addColumnIfMissing('companies', 'voice_twiml_app_sid', 'TEXT');
// Recording, voicemail and transcripts. record_calls announces itself to the other
// party — several of the states this portfolio works in require all-party consent.
addColumnIfMissing('companies', 'record_calls', 'INTEGER DEFAULT 0');
addColumnIfMissing('companies', 'voicemail_greeting', 'TEXT');
addColumnIfMissing('companies', 'forward_calls', 'INTEGER DEFAULT 0');
addColumnIfMissing('companies', 'voice_intel_sid', 'TEXT');   // Twilio Intelligence service, for call transcripts
// Stripe, the same way as Twilio: the company's own account first, the host second.
addColumnIfMissing('companies', 'stripe_secret_key', 'TEXT');
addColumnIfMissing('companies', 'stripe_webhook_secret', 'TEXT');
// Where a person's calls happen by default. 'softphone' talks through the browser;
// 'cell' rings their own handset and bridges. Either way the call runs through Twilio,
// so recording and transcription behave identically — the only difference is the
// hardware in your hand. NULL means "never chosen", and the app decides by device.
addColumnIfMissing('users', 'call_mode', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS call_recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL DEFAULT 'call' CHECK (kind IN ('call','voicemail')),
  call_sid TEXT,
  recording_sid TEXT UNIQUE,
  from_number TEXT,
  to_number TEXT,
  duration_sec INTEGER,
  transcript TEXT,
  transcript_status TEXT,          -- NULL | pending | done | failed
  transcript_sid TEXT,             -- Twilio Intelligence transcript, when used
  loan_id INTEGER REFERENCES loans(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recordings_co ON call_recordings(company_id, id);
`);

// Outbound email, same idea as texting: each servicer uses their own mailbox and the
// environment is only a fallback. Two from-addresses so routine correspondence and a
// serious late notice do not arrive from the same place.
addColumnIfMissing('companies', 'smtp_host', 'TEXT');
addColumnIfMissing('companies', 'smtp_port', 'INTEGER');
addColumnIfMissing('companies', 'smtp_user', 'TEXT');
addColumnIfMissing('companies', 'smtp_pass', 'TEXT');
addColumnIfMissing('companies', 'email_from_servicing', 'TEXT');  // statements, receipts, general
addColumnIfMissing('companies', 'email_from_legal', 'TEXT');      // late notices at 30+ days
addColumnIfMissing('companies', 'email_reply_to', 'TEXT');        // where replies to legal mail go
// Only needed when legal@ is a separate mailbox rather than a "send as" alias.
addColumnIfMissing('companies', 'email_legal_user', 'TEXT');
addColumnIfMissing('companies', 'email_legal_pass', 'TEXT');

addColumnIfMissing('companies', 'mgmt_company_name', 'TEXT');
addColumnIfMissing('companies', 'rep_name', 'TEXT');
addColumnIfMissing('companies', 'rep_phone', 'TEXT');
addColumnIfMissing('companies', 'mailing_address', 'TEXT');
addColumnIfMissing('companies', 'mailing_city', 'TEXT');
addColumnIfMissing('companies', 'mailing_state', 'TEXT');
addColumnIfMissing('companies', 'mailing_zip', 'TEXT');
addColumnIfMissing('ledger', 'fee_cents', 'INTEGER DEFAULT 0');
addColumnIfMissing('expenses', 'linked_account_id', 'INTEGER');
addColumnIfMissing('expenses', 'external_id', 'TEXT');
addColumnIfMissing('properties', 'status', "TEXT DEFAULT 'owned'"); // owned / listed / sold
addColumnIfMissing('properties', 'acquired_date', 'TEXT');
addColumnIfMissing('properties', 'purchase_price_cents', 'INTEGER DEFAULT 0');
addColumnIfMissing('properties', 'target_sale_price_cents', 'INTEGER DEFAULT 0');
addColumnIfMissing('properties', 'beds', 'INTEGER');
addColumnIfMissing('properties', 'baths', 'REAL');
addColumnIfMissing('properties', 'sqft', 'INTEGER');
addColumnIfMissing('properties', 'year_built', 'INTEGER');
// Late fee and grace live on the property so each deal can differ. The company
// setting is only a starting suggestion when you add a new property.
addColumnIfMissing('properties', 'late_fee_cents', 'INTEGER');
addColumnIfMissing('properties', 'grace_days', 'INTEGER');
addColumnIfMissing('properties', 'due_day', 'INTEGER');   // day of month payments are due
// Who holds title to this property, and in what form.
addColumnIfMissing('properties', 'owner_name', 'TEXT');
addColumnIfMissing('properties', 'owner_type', "TEXT DEFAULT 'llc'");
// What the buyer pays each month, broken out. Taxes and insurance are escrowed —
// that money is held for them. The other three are fees to the servicer.
// Whether the money has actually arrived.
//
// A card or Cash App payment is final the moment Stripe accepts it. An ACH debit is
// not: Stripe reports it as processing and the bank can return it up to four business
// days later for insufficient funds, and up to sixty for an unauthorised debit. Posting
// it as paid on the day it starts credits the loan for money that may never come, and —
// worse — stops the notice ladder on a buyer who has not actually paid.
//
// So a delayed payment lands as 'pending'. It shows on the ledger as initiated, it
// moves no balance, it posts nothing to the journal, and the loan stays exactly as past
// due as it was. When Stripe says it cleared, it is applied for real.
//
// Everything already in the table is money that was taken as final at the time, so the
// default is 'cleared' and no existing row changes meaning.
addColumnIfMissing('ledger', 'status', "TEXT NOT NULL DEFAULT 'cleared'");
addColumnIfMissing('ledger', 'cleared_at', 'TEXT');
addColumnIfMissing('ledger', 'returned_at', 'TEXT');
addColumnIfMissing('ledger', 'return_reason', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_status ON ledger(loan_id, status)');

// Money received that nobody has said what to do with yet. It used to be added to the
// buyer's escrow balance, which was wrong twice over: it is not escrow, and escrow is
// trust money held for a named person, so parking odd amounts there quietly overstates
// what is being held on their behalf. It waits here instead until a person allocates it.
//
// Existing escrow balances are left alone. This changes where new money goes, not where
// old money went — restating live buyer balances is not something a migration should do
// on its own.
addColumnIfMissing('loans', 'unapplied_cents', 'INTEGER NOT NULL DEFAULT 0');
// Every allocation decision, kept: who directed the money, when, into what, and why.
// The journal records the accounting; this records the judgement, which is the part
// somebody will want explained a year later.
db.exec(`
CREATE TABLE IF NOT EXISTS unapplied_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  allocated_at TEXT NOT NULL DEFAULT (datetime('now')),
  allocated_by INTEGER REFERENCES users(id),
  total_cents INTEGER NOT NULL,
  principal_cents INTEGER NOT NULL DEFAULT 0,
  interest_cents INTEGER NOT NULL DEFAULT 0,
  taxes_cents INTEGER NOT NULL DEFAULT 0,
  insurance_cents INTEGER NOT NULL DEFAULT 0,
  late_fee_cents INTEGER NOT NULL DEFAULT 0,
  admin_fee_cents INTEGER NOT NULL DEFAULT 0,
  postage_cents INTEGER NOT NULL DEFAULT 0,
  other_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  journal_entry_id INTEGER REFERENCES journal_entries(id)
);
CREATE INDEX IF NOT EXISTS idx_unapp_alloc_loan ON unapplied_allocations(loan_id, allocated_at);
`);
addColumnIfMissing('loans', 'monthly_taxes_cents', 'INTEGER DEFAULT 0');
addColumnIfMissing('loans', 'monthly_insurance_cents', 'INTEGER DEFAULT 0');
addColumnIfMissing('loans', 'monthly_utilities_cents', 'INTEGER DEFAULT 0');
addColumnIfMissing('loans', 'monthly_servicing_cents', 'INTEGER DEFAULT 0');
addColumnIfMissing('loans', 'monthly_misc_cents', 'INTEGER DEFAULT 0');
addColumnIfMissing('loans', 'misc_label', "TEXT DEFAULT 'Other monthly charge'");
addColumnIfMissing('loans', 'final_payment_date', 'TEXT');   // maturity, from first payment + term
// Once forfeiture or eviction is under way the automated ladder stops. From that point
// the notices that count are the statutory ones counsel sends, and an automated one
// landing beside them is a liability.
// Days of quiet after any payment before the ladder may escalate again. 0 means a
// partial payment does not by itself stop the notices — paying the arrears does, because
// the account stops being past due. Set it to 15 and anyone who pays anything buys a
// fortnight. Left at 0 by default so a token payment cannot silence a real default.
// How mail actually leaves. 'smtp' talks to a mail server on port 465/587; 'resend'
// posts over HTTPS on 443. The second exists because a lot of hosts — Railway among
// them — block outbound SMTP entirely, and no amount of correct credentials gets past
// a blocked port. HTTPS is never blocked, and the provider reports back what happened
// to each message, which for a default notice is part of the file.
addColumnIfMissing('companies', 'email_provider', "TEXT DEFAULT 'smtp'");
addColumnIfMissing('companies', 'email_api_key', 'TEXT');
addColumnIfMissing('companies', 'email_webhook_secret', 'TEXT');
// Delivery evidence, filled in later by the provider's webhook. Kept as timestamps
// beside status rather than as new status values, so the existing CHECK still holds.
addColumnIfMissing('email_log', 'provider_message_id', 'TEXT');
addColumnIfMissing('email_log', 'delivered_at', 'TEXT');
addColumnIfMissing('email_log', 'bounced_at', 'TEXT');
addColumnIfMissing('email_log', 'bounce_reason', 'TEXT');
addColumnIfMissing('companies', 'notice_pause_days', 'INTEGER DEFAULT 0');
// What a payment has to be worth before it earns that quiet. Without this the pause is a
// footgun: $1 against $900 of arrears would buy the same silence as $800, over and over,
// indefinitely. 0 means any payment counts, which is only safe when the pause is 0 too.
addColumnIfMissing('companies', 'notice_pause_min_cents', 'INTEGER DEFAULT 0');
// Certified mail through Lob: the key, the return address letters carry, and what one
// certified letter costs on the company's plan (Lob's API does not return the price,
// so the pass-through collection fee uses this figure — set it to what Lob charges).
addColumnIfMissing('companies', 'lob_api_key', 'TEXT');
addColumnIfMissing('companies', 'lob_cost_cents', 'INTEGER DEFAULT 0');
addColumnIfMissing('companies', 'mail_address_line1', 'TEXT');
addColumnIfMissing('companies', 'mail_address_city', 'TEXT');
addColumnIfMissing('companies', 'mail_address_state', 'TEXT');
addColumnIfMissing('companies', 'mail_address_zip', 'TEXT');
// What became of each certified letter, kept on the notice it carried.
addColumnIfMissing('notices', 'lob_id', 'TEXT');
addColumnIfMissing('notices', 'lob_tracking', 'TEXT');
addColumnIfMissing('notices', 'lob_status', 'TEXT');
addColumnIfMissing('notices', 'lob_expected', 'TEXT');
addColumnIfMissing('notices', 'lob_cost_cents', 'INTEGER');
// A letter bought with a test key renders and tracks exactly like a real one and is
// never printed or mailed. That difference is invisible everywhere it matters, so it
// is recorded on the notice itself: a test letter is not evidence of anything.
addColumnIfMissing('notices', 'lob_test', 'INTEGER DEFAULT 0');
// Where a buyer actually receives mail, when that is not the house. A notice of
// default is precisely the notice whose recipient may have already moved out, and a
// certified letter to an address they left produces a delivery scan that proves
// nothing. Empty means "mail it to the property", which is the common case.
addColumnIfMissing('users', 'mail_line1', 'TEXT');
addColumnIfMissing('users', 'mail_line2', 'TEXT');
addColumnIfMissing('users', 'mail_city', 'TEXT');
addColumnIfMissing('users', 'mail_state', 'TEXT');
addColumnIfMissing('users', 'mail_zip', 'TEXT');
// The unit number on a duplex or an apartment. It is not part of the street address
// because the street address is what identifies the property everywhere else in the
// app; it is a second address line that only mail cares about.
addColumnIfMissing('properties', 'unit', 'TEXT');
// A cost that happens on a schedule — lawn care weekly, insurance quarterly. The rule
// lives here; the money lives in property_costs, one materialized row per occurrence,
// so the cost basis and the books see ordinary cost rows and nothing changes downstream.
db.exec(`
CREATE TABLE IF NOT EXISTS recurring_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN
    ('purchase','closing','filing','rehab','bog','lawncare','birddog','insurance','taxes','utilities','marketing','legal','other')),
  description TEXT NOT NULL,
  vendor TEXT,
  amount_cents INTEGER NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly','biweekly','monthly','quarterly','annually')),
  next_date TEXT NOT NULL,           -- the next occurrence to materialize
  end_date TEXT,                     -- optional; the rule retires itself after this
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recurring_costs_due ON recurring_costs(active, next_date);
`);
// Trust documents were briefly a buyer-visible bucket. They are the ownership
// structure, not the buyer's file — pull back anything already shared. Idempotent.
try { run("UPDATE documents SET visible_to_tenant=0 WHERE category='trust_docs' AND visible_to_tenant=1"); } catch {}
// Lenders get a real phone and a real email, not one free-text "contact" field.
// Whatever was already typed into lender_contact sorts itself into the right slot.
addColumnIfMissing('pml_loans', 'lender_phone', 'TEXT');
addColumnIfMissing('pml_loans', 'lender_email', 'TEXT');
try {
  for (const pl of all(`SELECT id, lender_contact FROM pml_loans
      WHERE lender_contact IS NOT NULL AND lender_contact <> '' AND lender_phone IS NULL AND lender_email IS NULL`)) {
    const c = String(pl.lender_contact).trim();
    if (/@/.test(c) && !/\d{7}/.test(c.replace(/@.*/, ''))) run('UPDATE pml_loans SET lender_email=? WHERE id=?', c, pl.id);
    else if ((c.match(/\d/g) || []).length >= 7) run('UPDATE pml_loans SET lender_phone=? WHERE id=?', c, pl.id);
  }
} catch {}
// The notice pause is a per-loan exception, not a company policy. NULL means no rule:
// notices run on normal timing. A loan with no rule inherits nothing from anywhere.
addColumnIfMissing('loans', 'notice_pause_days', 'INTEGER');
addColumnIfMissing('loans', 'notice_pause_min_cents', 'INTEGER');
// One-time carry-over: a company that had the old global pause switched on gets it
// copied onto its active loans, so nobody's active grace quietly evaporates. The
// company fields are then zeroed and stop being consulted.
try {
  const withGlobal = all("SELECT id, notice_pause_days, notice_pause_min_cents FROM companies WHERE notice_pause_days > 0");
  for (const c of withGlobal) {
    run(`UPDATE loans SET notice_pause_days=?, notice_pause_min_cents=?
         WHERE company_id=? AND status='active' AND notice_pause_days IS NULL`,
      c.notice_pause_days, c.notice_pause_min_cents || 0, c.id);
    run('UPDATE companies SET notice_pause_days=0, notice_pause_min_cents=0 WHERE id=?', c.id);
    console.log(`Moved company ${c.id}'s global notice pause onto its active loans`);
  }
} catch {}
addColumnIfMissing('loans', 'legal_hold_at', 'TEXT');
addColumnIfMissing('loans', 'legal_hold_reason', 'TEXT');
addColumnIfMissing('loans', 'legal_hold_by', 'INTEGER');
addColumnIfMissing('properties', 'lat', 'REAL');
addColumnIfMissing('properties', 'lng', 'REAL');
addColumnIfMissing('properties', 'county', 'TEXT');   // individual | llc | land_trust | corporation | partnership | other
// Lifecycle phase. A property moves through these; selling to a buyer sets 'sold'.
addColumnIfMissing('properties', 'phase', "TEXT DEFAULT 'acquired'");
// Messages can carry rendered HTML alongside the plain-text body.
addColumnIfMissing('messages', 'body_html', 'TEXT');
addColumnIfMissing('messages', 'subject', 'TEXT');
addColumnIfMissing('messages', 'template_id', 'INTEGER');
// Which ways a message was sent, and how each one went. The in-app copy always exists;
// text and email are extra, and a failure on either has to be visible rather than
// swallowed — "I never got it" is a conversation worth having evidence for.
addColumnIfMissing('messages', 'channels', 'TEXT');        // csv: app,sms,email
addColumnIfMissing('messages', 'delivery_json', 'TEXT');   // per-channel result
addColumnIfMissing('notices', 'body_html', 'TEXT');
addColumnIfMissing('properties', 'phase_updated_at', 'TEXT');
// Where the house was advertised, and on what terms. The link alone is not enough —
// a Zillow listing disappears the day it sells, and two years later a dead link proves
// nothing. So the advertised terms are written down here at the same time, and compared
// against the agreement actually signed.
// Archiving hides a house without touching a thing. Reversible, unlike deleting.
addColumnIfMissing('properties', 'archived_at', 'TEXT');
addColumnIfMissing('properties', 'archived_reason', 'TEXT');
addColumnIfMissing('properties', 'listing_url', 'TEXT');
addColumnIfMissing('properties', 'listing_source', 'TEXT');      // zillow | website | facebook | other
addColumnIfMissing('properties', 'listing_price_cents', 'INTEGER');
addColumnIfMissing('properties', 'listing_down_cents', 'INTEGER');
addColumnIfMissing('properties', 'listing_payment_cents', 'INTEGER');
addColumnIfMissing('properties', 'listing_rate_bps', 'INTEGER');
addColumnIfMissing('properties', 'listing_captured_at', 'TEXT');
addColumnIfMissing('properties', 'listing_notes', 'TEXT');
// Scheduled lender payments: when they are due and whether to auto-record them.
addColumnIfMissing('pml_loans', 'payment_day', 'INTEGER');
// Day of the month the draft is attempted. Existing enrollments get the 1st, which is
// what they were already doing in practice — the sweep charged at the first opportunity
// in the month, and for a loan due on the 1st that is the 1st.
addColumnIfMissing('autopay', 'charge_day', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('pml_loans', 'autopay_enabled', 'INTEGER DEFAULT 0');
addColumnIfMissing('pml_loans', 'autopay_method', "TEXT DEFAULT 'bank_transfer'");
addColumnIfMissing('pml_loans', 'autopay_last_period', 'TEXT');
addColumnIfMissing('pml_loans', 'autopay_note', 'TEXT');
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

// Older databases created property_costs before 'filing' existed as a category.
// SQLite cannot alter a CHECK constraint, so rebuild the table when we spot the old one.
// Widen document categories on older databases the same way.
(function migrateDocCategories() {
  const t = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'");
  if (!t || t.sql.includes("'acquisition'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(t.sql
    .replace('CREATE TABLE documents', 'CREATE TABLE documents_new')
    .replace("CHECK (category IN ('loan_docs','insurance','taxes','utilities','correspondence','statement','private','other'))",
             "CHECK (category IN ('loan_docs','acquisition','pml_docs','sale_closing','insurance','taxes','utilities','correspondence','statement','private','other'))"));
  const cols = db.prepare('PRAGMA table_info(documents)').all().map(c => c.name).join(',');
  db.exec(`INSERT INTO documents_new (${cols}) SELECT ${cols} FROM documents;
           DROP TABLE documents; ALTER TABLE documents_new RENAME TO documents;`);
  db.exec('PRAGMA foreign_keys = ON');
  console.log('Widened document categories for acquisition, PML and sale closing sets');
})();

// Trust documents, closing receipts, and the unsorted tray for batch uploads. The
// replace is a regex because the CHECK's whitespace differs between a fresh install
// and one that went through the earlier widening.
(function migrateDocCategories2() {
  const t = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'");
  if (!t || t.sql.includes("'trust_docs'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(t.sql
    .replace(/^CREATE TABLE .?documents.?/, 'CREATE TABLE documents_new')
    .replace(/CHECK \(category IN \([^)]*\)\)/,
      "CHECK (category IN ('loan_docs','acquisition','pml_docs','sale_closing','trust_docs','closing_receipts'," +
      "'insurance','taxes','utilities','correspondence','statement','private','unsorted','other'))"));
  const cols = db.prepare('PRAGMA table_info(documents)').all().map(c => c.name).join(',');
  db.exec(`INSERT INTO documents_new (${cols}) SELECT ${cols} FROM documents;
           DROP TABLE documents; ALTER TABLE documents_new RENAME TO documents;`);
  db.exec('PRAGMA foreign_keys = ON');
  console.log('Widened document categories for trust docs, closing receipts and the unsorted tray');
})();

// Two Misc buckets — one the buyer sees, one only you do. Same rebuild dance.
(function migrateDocCategories3() {
  const t = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'");
  if (!t || t.sql.includes("'misc_shared'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(t.sql
    .replace(/^CREATE TABLE .?documents.?/, 'CREATE TABLE documents_new')
    .replace(/CHECK \(category IN \([^)]*\)\)/,
      "CHECK (category IN ('loan_docs','acquisition','pml_docs','sale_closing','trust_docs','closing_receipts'," +
      "'insurance','taxes','utilities','correspondence','statement','private','unsorted'," +
      "'misc_shared','misc_admin','other'))"));
  const cols = db.prepare('PRAGMA table_info(documents)').all().map(c => c.name).join(',');
  db.exec(`INSERT INTO documents_new (${cols}) SELECT ${cols} FROM documents;
           DROP TABLE documents; ALTER TABLE documents_new RENAME TO documents;`);
  db.exec('PRAGMA foreign_keys = ON');
  console.log('Widened document categories for the two Misc buckets');
})();

(function migrateCostCategories() {
  const t = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='property_costs'");
  if (!t || t.sql.includes("'filing'")) return;
  db.exec(`
    ALTER TABLE property_costs RENAME TO property_costs_old;
    CREATE TABLE property_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      property_id INTEGER NOT NULL REFERENCES properties(id),
      category TEXT NOT NULL DEFAULT 'other' CHECK (category IN
        ('purchase','closing','filing','rehab','bog','insurance','taxes','utilities','marketing','legal','other')),
      description TEXT NOT NULL,
      vendor TEXT,
      amount_cents INTEGER NOT NULL,
      cost_date TEXT,
      document_id INTEGER REFERENCES documents(id),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO property_costs SELECT * FROM property_costs_old;
    DROP TABLE property_costs_old;
  `);
  console.log('Migrated property_costs to include filing fees');
})();

// Lawn care earns its own line — it is the most repeated cost a held house has.
// Same rebuild for both tables that carry the category list.
(function migrateCostCategories2() {
  for (const table of ['property_costs', 'recurring_costs']) {
    const t = get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}'`);
    if (!t || t.sql.includes("'lawncare'")) continue;
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(t.sql
      .replace(new RegExp('^CREATE TABLE .?' + table + '.?'), `CREATE TABLE ${table}_new`)
      .replace(/CHECK \(category IN\s*\([^)]*\)\)/,
        "CHECK (category IN ('purchase','closing','filing','rehab','bog','lawncare'," +
        "'insurance','taxes','utilities','marketing','legal','other'))"));
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).join(',');
    db.exec(`INSERT INTO ${table}_new (${cols}) SELECT ${cols} FROM ${table};
             DROP TABLE ${table}; ALTER TABLE ${table}_new RENAME TO ${table};`);
    db.exec('PRAGMA foreign_keys = ON');
    console.log(`Widened ${table} categories for lawn care`);
  }
})();

// Bird dogs and wholesalers get paid to find the deal — that fee is part of the
// property's basis and deserves its own line, not a lump under Other.
(function migrateCostCategories3() {
  for (const table of ['property_costs', 'recurring_costs']) {
    const t = get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}'`);
    if (!t || t.sql.includes("'birddog'")) continue;
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(t.sql
      .replace(new RegExp('^CREATE TABLE .?' + table + '.?'), `CREATE TABLE ${table}_new`)
      .replace(/CHECK \(category IN\s*\([^)]*\)\)/,
        "CHECK (category IN ('purchase','closing','filing','rehab','bog','lawncare','birddog'," +
        "'insurance','taxes','utilities','marketing','legal','other'))"));
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).join(',');
    db.exec(`INSERT INTO ${table}_new (${cols}) SELECT ${cols} FROM ${table};
             DROP TABLE ${table}; ALTER TABLE ${table}_new RENAME TO ${table};`);
    db.exec('PRAGMA foreign_keys = ON');
    console.log(`Widened ${table} categories for bird dog / wholesale fees`);
  }
})();

// Older databases only allowed two agreement types. SQLite cannot alter a CHECK,
// so widen it by rebuilding the table when the old constraint is still in place.
(function migrateAgreementTypes() {
  const t = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='loans'");
  if (!t || t.sql.includes("'agreement_for_deed'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(t.sql
    .replace('CREATE TABLE loans', 'CREATE TABLE loans_new')
    .replace("CHECK (loan_type IN ('land_contract','land_trust_beneficial_interest'))",
             "CHECK (loan_type IN ('agreement_for_deed','land_contract','land_trust_beneficial_interest'))"));
  const cols = db.prepare('PRAGMA table_info(loans)').all().map(c => c.name).join(',');
  db.exec(`INSERT INTO loans_new (${cols}) SELECT ${cols} FROM loans;
           DROP TABLE loans; ALTER TABLE loans_new RENAME TO loans;`);
  db.exec('PRAGMA foreign_keys = ON');
  console.log('Widened loan agreement types to include agreement for deed');
})();

CREATE_INDEXES();
function CREATE_INDEXES() {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_props_co ON properties(company_id);
    CREATE INDEX IF NOT EXISTS idx_loans_co ON loans(company_id);
    CREATE INDEX IF NOT EXISTS idx_pml_co ON pml_loans(company_id);
    CREATE INDEX IF NOT EXISTS idx_docs_co ON documents(company_id);
    CREATE INDEX IF NOT EXISTS idx_exp_co ON expenses(company_id);
    CREATE INDEX IF NOT EXISTS idx_users_co ON users(company_id);
    CREATE INDEX IF NOT EXISTS idx_pm_user ON payment_methods(user_id);
    CREATE INDEX IF NOT EXISTS idx_linked_co ON linked_accounts(company_id);
    CREATE INDEX IF NOT EXISTS idx_costs_prop ON property_costs(property_id);
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_exp_external ON expenses(external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_email_log_loan ON email_log(loan_id, id);
    CREATE INDEX IF NOT EXISTS idx_email_log_co ON email_log(company_id, id);
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

// ---------- tasks & calendar ----------
// Work items, optionally pinned to a property or a loan. Everything here is internal:
// buyers never see a task. A task with a date lands on the calendar; one without sits
// in the list until it is given a date or ticked off.
db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  property_id INTEGER REFERENCES properties(id),      -- NULL = a one-off, not tied to a house
  loan_id INTEGER REFERENCES loans(id),
  title TEXT NOT NULL,
  notes TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  due_date TEXT,                                      -- YYYY-MM-DD, NULL = no date yet
  due_time TEXT,                                      -- HH:MM, NULL = all day
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  completed_at TEXT,
  completed_by INTEGER REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  repeat_every TEXT NOT NULL DEFAULT 'none'
    CHECK (repeat_every IN ('none','weekly','biweekly','monthly','quarterly','yearly')),
  repeat_until TEXT,
  remind_days_before INTEGER,                          -- pop-up this many days ahead
  reminded_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_company_due ON tasks(company_id, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_property ON tasks(property_id);
`);

// Renewal dates that belong to the house rather than to a task, so the calendar can
// surface them without anyone having to remember to create a reminder.
addColumnIfMissing('properties', 'insurance_expires', 'TEXT');
addColumnIfMissing('properties', 'insurance_carrier', 'TEXT');
addColumnIfMissing('properties', 'tax_due_date', 'TEXT');
// Most counties bill in two installments — summer and winter in Michigan.
addColumnIfMissing('properties', 'tax_due_date2', 'TEXT');
// Auto-generated tasks carry the thing they came from, so the sweep that creates them
// can run as often as it likes without ever making a second copy.
addColumnIfMissing('tasks', 'source_key', 'TEXT');
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source
  ON tasks(source_key) WHERE source_key IS NOT NULL;`);

// ---------- Michigan forfeiture track ----------
// A property in Michigan carries its district court on its back — typed once, reused
// on every DC 101 the house ever needs.
// What an Illinois forfeiture notice has to recite about the property. None of it is
// derivable — it comes off the deed and the recorded memorandum — so it is typed once
// per house and remembered. A notice that cannot name the legal description, the PIN
// and the recording is not a notice anybody should serve.
addColumnIfMissing('properties', 'legal_description', 'TEXT');
addColumnIfMissing('properties', 'pin', 'TEXT');                       // parcel index number
addColumnIfMissing('properties', 'memo_recorded_county', 'TEXT');      // county recorder's office
addColumnIfMissing('properties', 'memo_recorded_date', 'TEXT');        // YYYY-MM-DD
addColumnIfMissing('properties', 'memo_document_no', 'TEXT');
addColumnIfMissing('properties', 'escrow_agent', 'TEXT');              // where the contract is escrowed
// The court is the property's, not the seller's. Michigan already stores these; Illinois
// uses the same three columns for its circuit court, which is why they are not renamed.
addColumnIfMissing('properties', 'court_district', 'TEXT');
addColumnIfMissing('properties', 'court_address', 'TEXT');
addColumnIfMissing('properties', 'court_phone', 'TEXT');
// The date on the land contract itself — the form asks for it, and it is not the
// first payment date.
addColumnIfMissing('loans', 'contract_date', 'TEXT');
// How the payment is structured: PITI escrows taxes and insurance; PIT escrows taxes
// only and the buyer pays insurance directly. The welcome guide, and eventually every
// buyer-facing explanation of the payment, reads this rather than guessing.
addColumnIfMissing('loans', 'escrow_structure', "TEXT NOT NULL DEFAULT 'piti' CHECK (escrow_structure IN ('pit','piti'))");
// A template row can claim one of the system emails — welcome guide, escrow update,
// payoff ready, partial-payment receipt. When a company customizes one, its wording
// replaces the built-in intro; the computed numbers block is always appended so a
// wording change can never garble an amount.
addColumnIfMissing('message_templates', 'system_key', 'TEXT');
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_system
  ON message_templates(company_id, system_key) WHERE system_key IS NOT NULL AND archived=0;`);
// A DC 101 lives on the notices table like every other notice, but it has a life
// cycle the others don't: prepared (drafted by the sweep, waiting for a human),
// served (mailed certified; the statutory clock starts), and a cure deadline the
// watcher compares against the calendar. fill_json holds the reviewed field values
// so the court copy re-renders exactly as served.
addColumnIfMissing('notices', 'prepared', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('notices', 'served_at', 'TEXT');
addColumnIfMissing('notices', 'cure_deadline', 'TEXT');
addColumnIfMissing('notices', 'fill_json', 'TEXT');


// ---------- contacts ----------
// The people you deal with on a house: boots on the ground, the attorney, the insurance
// agent, the title company. Kept once at company level and attached to whichever
// properties they work on, so a number is typed in once and reused.
db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'other',
  business_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT, city TEXT, state TEXT, zip TEXT,
  notes TEXT,
  archived_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS property_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  role_note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(property_id, contact_id)
);

-- Every text to or from a contact, so the history survives phone changes and staff changes.
CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  contact_id INTEGER REFERENCES contacts(id),
  property_id INTEGER REFERENCES properties(id),
  direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  phone TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  error TEXT,
  sent_by INTEGER REFERENCES users(id),
  read_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cmsg_contact ON contact_messages(contact_id, id);
CREATE INDEX IF NOT EXISTS idx_cmsg_company ON contact_messages(company_id, id);
`);

// ---------- the call log ----------
// Every call leaves a row the moment it happens — placed from the browser, bridged to a
// cell, or arriving on the business number — whether or not recording is on. Without
// this, call history only existed when a recording did, and the unified communication
// log would have holes exactly where recording was off. Duration and status arrive
// later from Twilio's callbacks; a row with none means the call was placed and nothing
// more was heard, which is itself worth knowing.
db.exec(`
CREATE TABLE IF NOT EXISTS call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  mode TEXT CHECK (mode IN ('softphone','cell','inbound')),
  call_sid TEXT,
  counterpart_phone TEXT,            -- the buyer's/vendor's number, normalized
  counterpart_name TEXT,             -- as known at call time; history survives renames
  user_id INTEGER REFERENCES users(id),
  loan_id INTEGER REFERENCES loans(id),
  contact_id INTEGER REFERENCES contacts(id),
  property_id INTEGER REFERENCES properties(id),
  duration_sec INTEGER,
  status TEXT DEFAULT 'placed',      -- placed | completed | missed | voicemail
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_call_log_co ON call_log(company_id, id);
CREATE INDEX IF NOT EXISTS idx_call_log_prop ON call_log(property_id, id);
CREATE INDEX IF NOT EXISTS idx_call_log_sid ON call_log(call_sid);
`);

// Emails filed against the property and the vendor they concern, not only the loan —
// added here, after contacts and properties exist, because a column with a foreign key
// reference cannot be added before the table it points at.
addColumnIfMissing('email_log', 'property_id', 'INTEGER REFERENCES properties(id)');
addColumnIfMissing('email_log', 'contact_id', 'INTEGER REFERENCES contacts(id)');
db.exec(`CREATE INDEX IF NOT EXISTS idx_email_log_prop ON email_log(property_id, id);`);


// ---------- notes ----------
// Free-form notes an admin jots against a property or a loan — the phone call, the
// handshake agreement, the thing you will not remember in March. Internal only.
db.exec(`
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  property_id INTEGER REFERENCES properties(id),
  loan_id INTEGER REFERENCES loans(id),
  contact_id INTEGER REFERENCES contacts(id),
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  edited_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_property ON notes(property_id, id);
CREATE INDEX IF NOT EXISTS idx_notes_loan ON notes(loan_id, id);
`);

// ---------- late fee: 10% of P&I ----------
// The old default was zero, and the automatic late charge is gated on the fee being
// greater than zero — so every loan where nobody typed a number has silently never
// been charged one. Backfill those to the contractual 10% of principal and interest.
//
// Escrow is deliberately excluded: the fee is on the note payment, not on the taxes
// and insurance collected alongside it. On an $800 P&I with $50 escrow the fee is $80.
//
// Guarded by a settings row so it runs exactly once. Re-running would refill any loan
// an admin had deliberately set back to zero, which is a real choice on some deals.
if (!db.prepare("SELECT value FROM settings WHERE key='late_fee_10pct_backfill'").get()) {
  const n = db.prepare(`UPDATE loans SET late_fee_cents = CAST(ROUND(payment_cents * 0.10) AS INTEGER)
                        WHERE (late_fee_cents IS NULL OR late_fee_cents = 0) AND payment_cents > 0`).run().changes;
  db.prepare("INSERT INTO settings (key, value) VALUES ('late_fee_10pct_backfill', ?)")
    .run(new Date().toISOString() + ` (${n} loans)`);
  if (n) console.log(`Late fee defaulted to 10% of P&I on ${n} loan(s) that had none set.`);
}

// ---------- communications: who has seen what ----------
// One row per staff member per property, holding the moment they last opened that
// house's thread. "New" is anything that arrived after it, which keeps the count
// personal: a BOG reading a message on their phone does not clear the owner's badge.
// property_id 0 is the catch-all bucket for inbound that matched no house.
// Created after properties and users exist, because of the foreign keys.
db.exec(`
CREATE TABLE IF NOT EXISTS comms_seen (
  user_id INTEGER NOT NULL REFERENCES users(id),
  property_id INTEGER NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, property_id)
);
`);

ensureSeed();

// Emergency password reset. Set RESET_OWNER_PASSWORD (optionally RESET_OWNER_EMAIL) and
// redeploy; the password is changed on boot and the variable can then be deleted.
(function resetOwnerPassword() {
  const pw = process.env.RESET_OWNER_PASSWORD;
  if (!pw) return;
  const email = (process.env.RESET_OWNER_EMAIL || process.env.ADMIN_EMAIL || '').toLowerCase();
  const u = email
    ? get('SELECT * FROM users WHERE email=? AND deleted_at IS NULL', email)
    : get("SELECT * FROM users WHERE role='owner' AND deleted_at IS NULL ORDER BY id LIMIT 1");
  if (!u) { console.log('RESET_OWNER_PASSWORD set but no matching account found'); return; }
  run('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', hashPassword(pw), u.id);
  console.log(`Password reset for ${u.email}. Remove RESET_OWNER_PASSWORD from your variables now.`);
})();

module.exports = { db, get, all, run, hashPassword, verifyPassword };
