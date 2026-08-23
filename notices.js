// The late-notice ladder.
//
// A payment goes unpaid and a sequence of notices follows, each firing once, on its own
// day, through every channel at the same time — the app, a text and an email. The early
// rungs come from the servicing address. The later ones come from the legal address,
// because by then the conversation has changed.
//
// The ladder lives in a table rather than in this file, so the days and the wording can
// be changed without a deploy. The defaults are:
//
//     day  6  —  5-day late notice    servicing
//     day 16  — 15-day late notice    servicing
//     day 31  — 30-day late notice    legal
//     day 46  — 45-day late notice    legal
//     day 61  — 60-day late notice    legal   (backstop; usually already with counsel)
//
// The ladder stops when a payment arrives, and stops when the account is put on legal
// hold. Once forfeiture or eviction has been started the notices that matter are the
// statutory ones your attorney sends, and an automated reminder arriving alongside them
// is at best noise and at worst something quoted back at you.
//
// Two rules that matter more than they look:
//
//   Nothing fires inside the contractual grace period. Sending a late notice to somebody
//   who is still within the days their agreement gives them is wrong, and it is the kind
//   of wrong that gets quoted back at you.
//
//   If several rungs come due at once — the app was down, a loan was imported mid-default
//   — only the highest fires. The rest are recorded as skipped. Nobody should open their
//   phone to four notices about the same missed payment.

const { get, all, run } = require('./db');

const DEFAULT_LADDER = [
  { stage: 'late_5',  trigger_day: 6,  label: '5-day late notice',  identity: 'servicing', type: 'late_notice' },
  { stage: 'late_15', trigger_day: 16, label: '15-day late notice', identity: 'servicing', type: 'late_notice' },
  { stage: 'late_30', trigger_day: 31, label: '30-day late notice', identity: 'legal',     type: 'legal_notice' },
  { stage: 'late_45', trigger_day: 46, label: '45-day late notice', identity: 'legal',     type: 'legal_notice' },
  // By 60 days this is usually already with a lawyer. Here as a backstop for the
  // account that slipped through rather than as a step anyone expects to use.
  { stage: 'late_60', trigger_day: 61, label: '60-day late notice', identity: 'legal',     type: 'legal_notice' },
];

function initSchema() {
  const { db } = require('./db');
  db.exec(`
CREATE TABLE IF NOT EXISTS notice_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  stage TEXT NOT NULL,
  label TEXT NOT NULL,
  trigger_day INTEGER NOT NULL,              -- days past the due date
  notice_type TEXT NOT NULL DEFAULT 'late_notice'
    CHECK (notice_type IN ('late_notice','legal_notice','custom')),
  email_identity TEXT NOT NULL DEFAULT 'servicing'
    CHECK (email_identity IN ('servicing','legal')),
  channels TEXT NOT NULL DEFAULT 'app,sms,email',
  subject TEXT,
  body TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (company_id, stage)
);
CREATE INDEX IF NOT EXISTS idx_notice_rules_co ON notice_rules(company_id, trigger_day);
`);
  // notices predates the ladder; give it somewhere to record which rung fired and how
  // each channel went.
  const cols = db.prepare('PRAGMA table_info(notices)').all().map(c => c.name);
  if (!cols.includes('stage')) db.exec('ALTER TABLE notices ADD COLUMN stage TEXT');
  if (!cols.includes('delivery_json')) db.exec('ALTER TABLE notices ADD COLUMN delivery_json TEXT');
  if (!cols.includes('days_past_due')) db.exec('ALTER TABLE notices ADD COLUMN days_past_due INTEGER');
}

function seedLadder(companyId) {
  for (const r of DEFAULT_LADDER) {
    run(`INSERT OR IGNORE INTO notice_rules
      (company_id, stage, label, trigger_day, notice_type, email_identity, channels)
      VALUES (?,?,?,?,?,?, 'app,sms,email')`,
      companyId, r.stage, r.label, r.trigger_day, r.type, r.identity);
  }
}

const rulesFor = (companyId) =>
  all('SELECT * FROM notice_rules WHERE company_id=? AND active=1 ORDER BY trigger_day', companyId);

// ---------- wording ----------
// Kept here rather than in the table so a company that has not customised anything
// still sends something sensible. A rule with its own subject/body overrides this.
function defaultWording(rule, { loan, property, tenant, amountCents, dueDate, daysPast }) {
  const amt = '$' + (amountCents / 100).toFixed(2);
  const addr = property ? property.address : 'your property';
  const name = (tenant && tenant.name) || 'there';
  const late = loan.late_fee_cents
    ? ` A late fee of $${(loan.late_fee_cents / 100).toFixed(2)} may apply under your agreement.` : '';

  if (rule.notice_type === 'legal_notice') {
    return {
      subject: `IMPORTANT: Notice of Default — ${addr}`,
      body: `Dear ${name},\n\n` +
        `This is a formal notice that your account for ${addr} is seriously past due. The payment of ` +
        `${amt} due ${dueDate} remains unpaid ${daysPast} days after its due date, and earlier notices ` +
        `have not resolved it.\n\n` +
        `Under the terms of your agreement, continued non-payment may lead to default proceedings, ` +
        `including forfeiture or eviction and any additional fees and costs the law allows.\n\n` +
        `To stop that happening, pay the full past-due amount now through the app, or contact us today ` +
        `to make an arrangement. If you are struggling, tell us — it is far easier to sort out before ` +
        `it goes further.\n\n` +
        `This notice is in addition to, and does not replace, any notice your agreement or the law ` +
        `requires to be delivered another way.\n\n— ${'Loan Servicing'}`,
    };
  }
  return {
    subject: `Late Payment Notice — ${addr}`,
    body: `Dear ${name},\n\n` +
      `Your payment of ${amt} due ${dueDate} for ${addr} has not reached us and is now ${daysPast} ` +
      `days past due.${late}\n\n` +
      `You can pay in the app by card, bank transfer or Cash App Pay. If something has gone wrong, ` +
      `message us — we would much rather hear from you.\n\n` +
      `If you have already paid, please ignore this and let us know so we can match it up.\n\n— Loan Servicing`,
  };
}

// ---------- which rung is due ----------
// Returns the single highest rule this loan has crossed and not yet been sent for,
// plus any lower ones to mark as skipped.
function dueRule(companyId, loanId, period, daysPast) {
  const rules = rulesFor(companyId);
  const already = new Set(all('SELECT stage FROM notices WHERE loan_id=? AND period=? AND stage IS NOT NULL',
    loanId, period).map(r => r.stage));
  const crossed = rules.filter(r => daysPast >= r.trigger_day && !already.has(r.stage));
  if (!crossed.length) return null;
  const fire = crossed[crossed.length - 1];        // highest rung crossed
  return { fire, skip: crossed.slice(0, -1) };
}

module.exports = { initSchema, seedLadder, rulesFor, defaultWording, dueRule, DEFAULT_LADDER };
