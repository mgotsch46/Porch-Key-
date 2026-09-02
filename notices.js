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

// ---------- Michigan ----------
// Michigan land contracts do not walk the generic ladder. Statute gives them their
// own clock (MCL 600.5726–.5730): a 5-day late notice with non-waiver language on
// day 6, the DC 101 forfeiture notice served by certified mail on day 10, a cure
// period of at least 15 days from service, and — if the cure deadline passes unpaid —
// the forfeiture complaint (DC 102) filed in the district court where the property
// sits. The app prepares and mails; the complaint is filed by a human.
//
// The court belongs to the property's district, not to the seller. These are the
// districts the portfolio actually uses; a property elsewhere in Michigan gets its
// court typed in once on the serve screen and remembered on the property.
const MI_COURTS = [
  { county: /genesee/i, city: /flint|burton|grand blanc|flushing|davison|fenton|clio|mt\.? morris|swartz creek|montrose|otisville|goodrich|linden/i,
    district: '67th', name: '67th District Court',
    address: '630 S. Saginaw St., Flint, MI 48502', phone: '',
    filing: 'Flint (67th District): file 3 copies of the served forfeiture notice and 3 copies of the ' +
      'land contract with the $55 filing fee — cash or money order only — plus stamped self-addressed envelopes.' },
  { county: /saginaw/i, city: /saginaw/i,
    district: '70th', name: '70th District Court',
    address: '111 S. Michigan Ave., 3rd Floor, Saginaw, MI 48602', phone: '989-790-5380',
    filing: 'Saginaw (70th District): file with the Civil Division, 3rd floor. Call 989-790-5380 ahead ' +
      'for the current fee and copy count.' },
  { county: /wayne/i, city: /detroit|highland park|hamtramck/i,
    district: '36th', name: '36th District Court',
    address: '421 Madison St., Detroit, MI 48226', phone: '313-965-2200',
    filing: 'Detroit (36th District): Civil Division, 2nd floor. Their standard landlord-tenant filing ' +
      'checklist does NOT apply to land contract forfeitures — confirm requirements at the cashier counter.' },
];

function miCourtFor(property) {
  if (!property) return null;
  const county = property.county || '';
  const city = property.city || '';
  return MI_COURTS.find(c => (county && c.county.test(county)) || (city && c.city.test(city))) || null;
}

const isMichigan = (property) => !!property && String(property.state || '').trim().toUpperCase() === 'MI';

// Accepting a partial payment must never read as forgiving the default. This is the
// reservation-of-rights clause from the company's own notice packet, used verbatim on
// the 5-day notice and echoed on every partial-payment receipt.
const MI_NON_WAIVER =
  "Seller's acceptance of any late payment, partial payment, or payment tendered after its due date " +
  'does not and shall not constitute any of the following: (a) a waiver of Seller\'s right to require ' +
  'strict and timely performance of every term of the Land Contract; (b) a waiver of this default or ' +
  'of any prior or subsequent default; (c) an election of remedies; (d) a modification or amendment ' +
  'of the Land Contract, or a course of dealing altering its payment terms; or (e) a reinstatement of ' +
  'the Land Contract, except as expressly stated in a writing signed by Seller.\n\n' +
  'No delay or omission by Seller in exercising any right or remedy shall impair that right or remedy ' +
  'or be construed as a waiver of it. Any payment accepted will be applied first to accrued late ' +
  'charges, then to sums advanced by Seller for taxes and insurance, then to accrued interest, and ' +
  'last to principal. Seller expressly reserves all rights and remedies available ' +
  'under the Land Contract and under Michigan law, including MCL 600.5726 et seq.';

// The receipt's version: acceptance of the money is expressly conditional.
const MI_PARTIAL_NON_WAIVER =
  'Seller accepts the payment described above ON THE EXPRESS CONDITION that it is applied to the ' +
  'outstanding balance only, and that acceptance does NOT: cure the existing default, which remains ' +
  'in effect as to the remaining balance; waive Seller\'s right to require strict and timely ' +
  'performance of every term of the Land Contract; waive this default or any other default, past, ' +
  'present, or future; reinstate, revive, or continue the Land Contract beyond its existing terms; ' +
  'create a modification, amendment, novation, or course of dealing altering the payment terms; ' +
  'extend, restart, toll, or otherwise affect any cure period under MCL 600.5728 or any notice ' +
  'already served; or constitute an election of remedies.\n\n' +
  'Seller expressly reserves every right and remedy available under the Land Contract and under ' +
  'Michigan law, including MCL 600.5726 et seq., and including the right to proceed with or continue ' +
  'forfeiture proceedings for the remaining unpaid balance.';

// The 5-day notice, from the company's own template: a contractual courtesy notice
// with a courtesy cure date three days out, a plain warning of what day 10 brings,
// and the reservation of rights in full. It says explicitly what it is not — the
// statutory DC 101 — because confusing the two is how cure periods get miscounted.
function miLateNoticeWording({ company, loan, property, tenant, status, dueDate, missedDates,
                               feeCharged, feesCents, todayIso, borrowers, advances }) {
  const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const us = (iso) => { const [y, m, d] = iso.split('-'); return `${Number(m)}/${Number(d)}/${y}`; };
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  const addr = property ? `${property.address}, ${property.city}, Michigan ${property.zip}` : 'the property';
  const seller = (property && property.trust_name) || (company && (company.mgmt_company_name || company.name)) || 'Seller';
  const servicer = (company && (company.mgmt_company_name || company.name)) || 'Loan Servicing';
  const servicingEmail = (company && (company.email_from_servicing || company.contact_email)) || '';
  const pi = Math.max(0, status.owed_now_cents - status.fees_due_cents);

  // The cure date is normally eight days past the due date — two days after a notice
  // that goes out on day 6. But the notice does not always go out on day 6. A longer
  // grace period holds the sweep back, and a loan imported mid-default arrives already
  // months down, so the first notice it ever sees can be written on day 40.
  //
  // A cure deadline that had already passed when the letter was written is worse than
  // no deadline at all: it demands the impossible, and it is exactly the sentence that
  // gets read back in court. So both dates are floored against the day the notice is
  // actually written. On normal timing the floor never binds and the dates are
  // unchanged.
  const later = (a, b) => (a > b ? a : b);
  const cureBy = later(addDays(dueDate, 8), addDays(todayIso, 2));
  const dc101On = later(addDays(dueDate, 9), addDays(cureBy, 1));
  const feeLine = feeCharged
    ? `Late charge (per your Land Contract): ${money(loan.late_fee_cents)} — this charge has been applied.\n`
    : (status.fees_due_cents > pi ? '' : '');

  // Taxes and insurance the seller fronted because escrow was short are their own
  // lines on the company's template, and they should be: they are not late charges and
  // they are not principal, and a purchaser is entitled to see what was advanced on
  // their behalf before being asked to repay it. Both come from the escrow
  // disbursements actually paid, so nothing appears here that was not really spent.
  const advTax = advances && advances.taxes_cents ? advances.taxes_cents : 0;
  const advIns = advances && advances.insurance_cents ? advances.insurance_cents : 0;
  const advanceLines =
    (advTax ? `Property taxes advanced by Seller: ${money(advTax)}\n` : '') +
    (advIns ? `Insurance premiums advanced by Seller: ${money(advIns)}\n` : '');
  // Whatever is left in fees once the named lines are accounted for.
  const otherFees = Math.max(0, status.fees_due_cents - (feeCharged ? loan.late_fee_cents : 0) - advTax - advIns);

  const body =
`NOTICE OF LATE PAYMENT AND DEFAULT
Michigan Land Contract — Reservation of Rights

Date of notice: ${us(todayIso)}
To: ${(borrowers && borrowers.length ? borrowers.join('; ') : ((tenant && tenant.name) || 'Purchaser'))}, Purchaser${borrowers && borrowers.length > 1 ? 's' : ''}
Property: ${addr}${loan.contract_date ? `\nLand contract dated: ${us(loan.contract_date)}` : ''}

1. PAYMENT NOT RECEIVED
Under your Land Contract, the installment due ${us(dueDate)} has not been received. The grace period has expired and you are in default.

2. AMOUNT NOW PAST DUE
Past-due principal and interest: ${money(pi)}
${feeLine}${advanceLines}${otherFees > 0 ? `Other fees and charges due: ${money(otherFees)}\n` : ''}TOTAL NOW DUE: ${money(status.owed_now_cents)}
Payment due dates covered by this notice: ${(missedDates || []).map(us).join(', ') || us(dueDate)}.
You can pay in the app by card, bank transfer, or Cash App Pay, or contact us for other arrangements. Seller may require certified funds.

3. CURE REQUESTED BY ${us(cureBy).toUpperCase()}
Deliver the TOTAL NOW DUE on or before ${us(cureBy)}. If the full amount is not received by that date, Seller intends to serve a statutory Notice of Forfeiture (SCAO Form DC 101) on or about ${us(dc101On)}. That notice begins a 15-day cure period under MCL 600.5728. If that cure period expires without payment, Seller may file a complaint for possession in the Michigan district court where the property is located, under MCL 600.5735.

4. THIS IS NOT A NOTICE OF FORFEITURE
This letter is a contractual courtesy notice only. It is not the statutory notice of forfeiture required by MCL 600.5728, and it does not begin the 15-day statutory cure period. No statutory period begins until you are served with Form DC 101 by a method permitted under MCL 600.5730.

5. RESERVATION OF RIGHTS AND NON-WAIVER
${MI_NON_WAIVER}

6. QUESTIONS
If you dispute the amount stated above, or want to discuss a written payment arrangement, message us in the app, or contact the ${servicer} Servicing Department${servicingEmail ? ` at ${servicingEmail}` : ''}, before the cure date. Any arrangement is effective only if in writing and signed by Seller.

${seller}${servicer === seller ? '' : `\n${servicer}, as servicing agent`}
Servicing Department`;

  return {
    subject: `NOTICE OF LATE PAYMENT AND DEFAULT — ${property ? property.address : 'your account'}`,
    body,
  };
}

// certified: 1 on the 30-day rung only. That is the notice a forfeiture case leans on,
// and certified mail is what turns it from a claim into a tracking number with delivery
// scans. The earlier rungs are conversation; paying to mail them proves nothing.
const DEFAULT_LADDER = [
  { stage: 'late_5',  trigger_day: 6,  label: '5-day late notice',  identity: 'servicing', type: 'late_notice',  certified: 0 },
  { stage: 'late_15', trigger_day: 16, label: '15-day late notice', identity: 'servicing', type: 'late_notice',  certified: 0 },
  { stage: 'late_30', trigger_day: 31, label: '30-day late notice', identity: 'legal',     type: 'legal_notice', certified: 1 },
  { stage: 'late_45', trigger_day: 46, label: '45-day late notice', identity: 'legal',     type: 'legal_notice', certified: 0 },
  // By 60 days this is usually already with a lawyer. Here as a backstop for the
  // account that slipped through rather than as a step anyone expects to use.
  { stage: 'late_60', trigger_day: 61, label: '60-day late notice', identity: 'legal',     type: 'legal_notice', certified: 0 },
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

  // Whether this rung also goes by certified mail. It used to be decided by testing
  // the stage name against the string 'late_30', which quietly stopped the mail the
  // moment a ladder was retimed or a stage renamed — and the whole point of keeping
  // the ladder in a table is that it can be. It is a setting now.
  const ruleCols = db.prepare('PRAGMA table_info(notice_rules)').all().map(c => c.name);
  if (!ruleCols.includes('certified')) {
    db.exec('ALTER TABLE notice_rules ADD COLUMN certified INTEGER NOT NULL DEFAULT 0');
    // Existing ladders keep the behaviour they already had.
    db.exec("UPDATE notice_rules SET certified=1 WHERE stage='late_30'");
  }
}

function seedLadder(companyId) {
  for (const r of DEFAULT_LADDER) {
    run(`INSERT OR IGNORE INTO notice_rules
      (company_id, stage, label, trigger_day, notice_type, email_identity, channels, certified)
      VALUES (?,?,?,?,?,?, 'app,sms,email', ?)`,
      companyId, r.stage, r.label, r.trigger_day, r.type, r.identity, r.certified);
  }
}

const rulesFor = (companyId) =>
  all('SELECT * FROM notice_rules WHERE company_id=? AND active=1 ORDER BY trigger_day', companyId);

// ---------- wording ----------
// Kept here rather than in the table so a company that has not customised anything
// still sends something sensible. A rule with its own subject/body overrides this.
function defaultWording(rule, { loan, property, tenant, amountCents, dueDate, daysPast, reserveRights, feeCharged, company, borrowers }) {
  const amt = '$' + (amountCents / 100).toFixed(2);
  const addr = property ? property.address : 'your property';
  // The friendly rungs greet the buyer by first name; a formal notice of default names
  // everybody who signed, because it is addressed to all of them.
  const name = (tenant && tenant.name) || 'there';
  const allNames = (borrowers && borrowers.length)
    ? (borrowers.length === 1 ? borrowers[0]
       : borrowers.slice(0, -1).join(', ') + ' and ' + borrowers[borrowers.length - 1])
    : name;
  // A formal notice of default has to say who it is from. The Michigan template names
  // the servicer and the seller; this one used to sign off as nobody in particular.
  const servicer = (company && (company.mgmt_company_name || company.name)) || 'Loan Servicing';
  const late = feeCharged
    ? ` A late fee of $${(loan.late_fee_cents / 100).toFixed(2)} has been charged under your agreement.`
    : (loan.late_fee_cents
      ? ` A late fee of $${(loan.late_fee_cents / 100).toFixed(2)} may apply under your agreement.` : '');
  const reserve = reserveRights ? `\n\n${MI_NON_WAIVER}` : '';

  if (rule.notice_type === 'legal_notice') {
    return {
      subject: `IMPORTANT: Notice of Default — ${addr}`,
      body: `Dear ${allNames},\n\n` +
        `This is a formal notice that your account for ${addr} is seriously past due. The payment of ` +
        `${amt} due ${dueDate} remains unpaid ${daysPast} days after its due date, and earlier notices ` +
        `have not resolved it.\n\n` +
        `Under the terms of your agreement, continued non-payment may lead to default proceedings, ` +
        `including forfeiture or eviction and any additional fees and costs the law allows.\n\n` +
        `To stop that happening, pay the full past-due amount now through the app, or contact us today ` +
        `to make an arrangement. If you are struggling, tell us — it is far easier to sort out before ` +
        `it goes further.\n\n` +
        `This notice is in addition to, and does not replace, any notice your agreement or the law ` +
        `requires to be delivered another way.${reserve}\n\n— ${servicer}`,
    };
  }
  return {
    subject: `Late Payment Notice — ${addr}`,
    body: `Dear ${name},\n\n` +
      `Your payment of ${amt} due ${dueDate} for ${addr} has not reached us and is now ${daysPast} ` +
      `days past due.${late}\n\n` +
      `You can pay in the app by card, bank transfer or Cash App Pay. If something has gone wrong, ` +
      `message us — we would much rather hear from you.\n\n` +
      `If you have already paid, please ignore this and let us know so we can match it up.` +
      `${reserve}\n\n— ${servicer}`,
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

// ---------- Illinois ----------
// Installment sales contracts run their own sequence, from the company's SOP and the
// attorney's three letters. The shape of it:
//
//     day  6  —  Notice of Default                       certified
//     day 46  —  Notice of Intent to Declare Forfeiture   certified
//     day 75  —  eviction preparation                     a task for a person
//     day 85  —  5-Day Notice to Quit                     certified; personal service preferred
//     day 91  —  file forcible entry and detainer         a person, in the property's county
//
// Two cure periods run at once and they are easy to confuse. The ninety-day contract
// cure runs from the DATE OF DEFAULT — the missed due date — and no letter starts,
// extends or restarts it. The thirty-day forfeiture cure runs from the day the Intent
// notice goes out. Day 91 is the first day both have expired and the five-day demand
// has run, which is why nothing is filed before it.
const isIllinois = (property) => !!property && String(property.state || '').trim().toUpperCase() === 'IL';

const IL_LADDER = [
  { stage: 'il_default',   day: 6,  label: 'Notice of Default',                        certified: 1 },
  { stage: 'il_forfeit',   day: 46, label: 'Notice of Intent to Declare Forfeiture',   certified: 1 },
  { stage: 'il_5day',      day: 85, label: '5-Day Notice to Quit',                     certified: 1 },
];
const IL_PREP_DAY = 75;
const IL_FILE_DAY = 91;
const IL_CONTRACT_CURE_DAYS = 90;     // from the date of default
const IL_FORFEIT_CURE_DAYS = 30;      // from the date the Intent notice goes out

const ilMoney = (c) => '$' + ((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ilUs = (iso) => { if (!iso) return '____________'; const [y, m, d] = String(iso).split('-'); return `${Number(m)}/${Number(d)}/${y}`; };
const ilAdd = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// A blank in a legal notice should look like a blank, not like a missing value dressed
// up as one. Anything not held on the property comes through as a rule the reader can
// see, and the admin screen lists what is missing before the notice goes out.
const ilBlank = (v, width = 28) => (v && String(v).trim()) || '_'.repeat(width);
// 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st.
const ilOrdinal = (n) => {
  const v = Number(n) || 1;
  const tens = v % 100;
  if (tens >= 11 && tens <= 13) return `${v}th`;
  return `${v}${['th', 'st', 'nd', 'rd'][v % 10] || 'th'}`;
};

const ilSeller = (company, property) =>
  (property && property.trust_name) || (company && (company.mgmt_company_name || company.name)) || 'Seller';
const ilBuyerLine = (borrowers, tenant) => {
  const names = (borrowers && borrowers.length) ? borrowers : [(tenant && tenant.name) || ''].filter(Boolean);
  if (!names.length) return '____________________';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
};
const ilAddress = (property) => property
  ? `${property.address}${property.unit ? ' ' + property.unit : ''}, ${property.city}, Illinois ${property.zip}`
  : 'the property';

// ---------- day 6: Notice of Default ----------
// The attorney's letter, with the blanks filled. The ninety days run from the date of
// default, so the cure date is computed from the missed due date and not from today —
// posting this late does not buy the buyer more time, and must not appear to.
function ilDefaultWording({ company, loan, property, tenant, status, dueDate, missedDates,
                            payoffCents, todayIso, borrowers }) {
  const servicer = (company && (company.mgmt_company_name || company.name)) || 'Loan Servicing';
  const servicingEmail = (company && (company.email_from_servicing || company.contact_email)) || '';
  const seller = ilSeller(company, property);
  const buyers = ilBuyerLine(borrowers, tenant);
  const cureBy = ilAdd(dueDate, IL_CONTRACT_CURE_DAYS);
  const months = (missedDates && missedDates.length)
    ? missedDates.map(ilUs).join(', ')
    : ilUs(dueDate);

  const body =
`NOTICE OF DEFAULT

VIA CERTIFIED MAIL

${buyers}
${ilAddress(property)}

Re: ${buyers} — Real Property Installment Sales Contract dated ${ilUs(loan.contract_date)} for purchase of ${ilAddress(property)}

Dear ${buyers},

This letter is formal notice that you have defaulted under the terms of the Real Property Installment Sales Contract dated ${ilUs(loan.contract_date)} by and between ${seller} and ${buyers}. You have defaulted for failing to make the required monthly payments for ${months} and thereafter. At this time, the amount to reinstate or otherwise cure this default is ${ilMoney(status.owed_now_cents)}. At this time, the payoff balance due on your loan is ${ilMoney(payoffCents)}.

As a result of said default, you have ninety (90) days from the date of default to cure, by making all payments, fees and charges currently due under the contract by ${ilUs(cureBy)}.

You are also responsible for paying any amounts that become due from the date of this letter. This may include taxes, insurance, inspection fees, and other fees and charges, as permitted by applicable law.

If you do not timely cure this default, within 45 days of the end of 90-day period from the date of default, then Seller may, in addition to Seller's right to enforce the Agreement according to its terms, give notice in writing to Buyer (Notice of Intent to Declare Forfeiture). If you fail within thirty (30) days of the date of the Notice of Intent to Declare Forfeiture is mailed or personally served, to cure the default, then Seller may in the alternative, (A) enforce payment in full or (B) treat this Agreement at an end and re-enter and regain possession of Premises as if this Agreement had not existed and treat all payments made by buyer hereunder as rent and as agreed fair liquidated damages, or (C) re-enter and regain possession of Premises, electing not to treat payments as rent and as agreed fair liquidated damages, in which event Buyer shall, upon demand, pay Seller all amounts due as so accelerated less the fair market value of Premises on the date of such re-entry.

You can pay in the app by card, bank transfer, or Cash App Pay, or contact the ${servicer} Servicing Department${servicingEmail ? ` at ${servicingEmail}` : ''} to discuss a written arrangement. Any arrangement is effective only if in writing and signed by Seller.

Very truly yours,

${seller}${servicer === seller ? '' : `\n${servicer}, as servicing agent`}
Servicing Department`;

  return { subject: `NOTICE OF DEFAULT — ${property ? property.address : 'your account'}`, body, cureBy };
}

// ---------- day 46: Notice of Intent to Declare Forfeiture ----------
// Recites the contract, the recording and the property, then gives thirty days. The
// recitals come off the deed and the recorded memorandum, which is why the property
// has to carry them; anything missing prints as a blank rather than a wrong answer.
function ilForfeitureWording({ company, loan, property, tenant, status, dueDate,
                               missedDates, payoffCents, todayIso, borrowers }) {
  const seller = ilSeller(company, property);
  const servicer = (company && (company.mgmt_company_name || company.name)) || 'Loan Servicing';
  const buyers = ilBuyerLine(borrowers, tenant);
  const forfeitCureBy = ilAdd(todayIso, IL_FORFEIT_CURE_DAYS);
  const contractCureBy = ilAdd(dueDate, IL_CONTRACT_CURE_DAYS);
  const months = (missedDates && missedDates.length) ? missedDates.map(ilUs).join(', ') : ilUs(dueDate);
  const court = (property && property.court_district)
    ? property.court_district
    : `${ilBlank(property && property.county, 16)} County`;
  const pi = Math.max(0, (loan.payment_cents || 0));
  const taxes = Math.round((loan.monthly_taxes_cents || 0));
  const ins = Math.round((loan.monthly_insurance_cents || 0));

  const body =
`NOTICE OF INTENTION TO DECLARE A FORFEITURE OF ALL RIGHTS UNDER THE REAL PROPERTY INSTALLMENT SALES CONTRACT

AND

NOTICE OF INTENTION TO FILE FORCIBLE ENTRY AND DETAINER (EVICTION) ACTION

VIA CERTIFIED MAIL

${buyers}
${ilAddress(property)}

Please be notified as follows:

1. This notice relates to the Real Property Installment Sales Contract dated ${ilUs(loan.contract_date)} between ${seller} (Seller), and ${buyers} (Buyer), and escrowed at ${ilBlank(property && property.escrow_agent, 34)}, under which the Buyer agreed to purchase from the Seller, and the Seller agreed to sell to the Buyer, according to the terms of the Real Property Installment Sales Contract, the following legally described property:

Legal Description: ${ilBlank(property && property.legal_description, 40)}

PIN: ${ilBlank(property && property.pin, 20)}

Commonly Known As: ${ilAddress(property)}

2. A Memorandum of such Real Property Installment Sales Contract, signed by both the Seller and the Buyer, was duly recorded with the ${ilBlank(property && property.memo_recorded_county, 18)} County Recorder's Office on ${ilUs(property && property.memo_recorded_date)}, as Document No. ${ilBlank(property && property.memo_document_no, 20)}.

3. Under the Real Property Installment Sales Contract, the Buyer agreed the total sum of ${ilMoney(loan.sale_price_cents)} (Purchase Price) in the following manner: ${ilMoney(loan.down_payment_cents)} shall be immediately paid Seller as down payment (after application, resulting in a starting principal balance of ${ilMoney(loan.principal_cents)}), with interest from ${ilUs(loan.first_payment_date)}, at ${((loan.interest_rate_bps || 0) / 100).toFixed(2)}% per annum on the unpaid principal balance from time to time shall be payable in installments of ${ilMoney(pi + (loan.escrow_cents || 0))} [which includes ${ilMoney(pi)} principal and interest${taxes ? ` and ${ilMoney(taxes)} for taxes` : ''}${ins ? ` and ${ilMoney(ins)} for insurance` : ''}] (Installment Payment), the first installment being due ${ilUs(loan.first_payment_date)}, and successive installments due on the ${ilOrdinal(loan.due_day)} day of each month, thereafter until all sums due Seller are paid.

4. The Real Property Installment Sales Contract states that time is of the essence.

5. The Real Property Installment Sales Contract provides that, in the event of the Buyer's failure to make any payment due under the Real Property Installment Sales Contract, or for any other failure of the Buyer to perform any covenant under the Real Property Installment Sales Contract, the Seller may give notice in writing to Buyer that the principal balance and accrued interest are immediately due and payable (Notice of Acceleration).

6. The Buyer has failed to make the following payments under the Real Property Installment Sales Contract: the Buyer is in default for failing to make the required monthly payments for ${months} and thereafter.

THEREFORE, as the Buyer, ${buyers}, you are notified as follows:

A. The Seller intends to declare all of your rights under the Real Property Installment Sales Contract to be forfeited, and all payments made by you will be retained by the Seller, unless you cure the default by making all payments, fees and charges currently due under the contract, being ${ilMoney(status.owed_now_cents)}, by ${ilUs(forfeitCureBy)} or pay the principal balance in the amount of ${ilMoney(payoffCents)} under the Real Property Installment Sales Contract no later than ${ilUs(forfeitCureBy)}.

B. The Seller also intends to file a lawsuit against you to evict you from the property, by asking the ${court} Circuit Court to find that you no longer have the right to possess the property and to enter an order granting possession of the property to the Seller, unless you cure the default, or pay the contract in full before the aforementioned cure period elapses.

The ninety (90) day cure period running from the date of default expires ${ilUs(contractCureBy)}. This notice does not extend it.

Very truly yours,

${seller}${servicer === seller ? '' : `\n${servicer}, as servicing agent`}
Legal Department`;

  return {
    subject: `NOTICE OF INTENTION TO DECLARE FORFEITURE — ${property ? property.address : 'your account'}`,
    body, forfeitCureBy, contractCureBy,
  };
}

// ---------- day 85: 5-Day Notice to Quit ----------
// The attorney's form, kept as written. Only the payment instruction is ours, because
// the form points at a portal the company no longer uses and telling a buyer to pay
// somewhere they cannot is its own problem.
function ilFiveDayWording({ company, loan, property, tenant, status, todayIso, borrowers, baseUrl }) {
  const seller = ilSeller(company, property);
  const buyers = ilBuyerLine(borrowers, tenant);
  const fees = status.fees_due_cents || 0;
  const past = Math.max(0, status.owed_now_cents - fees);

  const body =
`5 DAY NOTICE TO QUIT

Date: ${ilUs(todayIso)}

This notice is sent to ${buyers} ("Tenant") and further directed to all residents, occupants, subtenants, and any others in possession of the Premises.

Property Address: ${ilAddress(property)} ("Premises")

Lease Start Date: ${ilUs(loan.contract_date || loan.first_payment_date)} ("Lease")

In accordance with your Lease and the laws of Illinois, after service on you of this notice, you are hereby given the following instructions:

[X] NONPAYMENT. Within 5 days, the Landlord demands the total amount due:

Past Rent: ${ilMoney(past)}
Late Fees and Other Fees: ${ilMoney(fees)}

TOTAL AMOUNT DUE: ${ilMoney(status.owed_now_cents)}

Payment Instructions: Pay in full immediately through your PorchPay account${baseUrl ? ` at ${baseUrl}/` : ''}, or contact ${(company && (company.mgmt_company_name || company.name)) || 'the Landlord'} to arrange certified funds.

If the above payment is not made within the required timeframe, the Tenant will be required to quit and deliver possession of the Premises.

YOU ARE FURTHER NOTIFIED that the Landlord hereby elects to declare that forfeiture of your Lease under which you hold possession of the Premises if you fail to perform or otherwise comply. Such noncompliance will institute legal proceedings to recover rent and possession of said Premises which shall result in a judgment against you including costs and necessary disbursements together with possible statutory damages as allowed by law for such unlawful detention.

Landlord Signature: ${seller}, Legal Department

Telephone: ${ilBlank(company && (company.rep_phone || company.phone), 14)}   E-Mail: ${ilBlank(company && (company.contact_email || company.email), 20)}`;

  return { subject: `5 DAY NOTICE TO QUIT — ${property ? property.address : 'your account'}`, body };
}

// What a DC 101 needs and the property does not yet carry. The court's own details
// come from MI_COURTS when the property has not overridden them — but that table has
// no telephone number for Flint, and the form has a field for it. Rather than invent a
// court's phone number, the gap is reported and typed in once on the property.
//
// The legal description is the other one. MCL 600.5728 does not demand it, but the
// form asks for "address or legal description" and a contested case is where the
// difference shows up.
function miMissingFields(property, court) {
  const gaps = [];
  const has = (v) => !!(v && String(v).trim());
  if (!has(property && property.legal_description)) gaps.push('Legal description');
  if (!has((property && property.court_district) || (court && court.district))) gaps.push('Judicial district');
  if (!has((property && property.court_address) || (court && court.address))) gaps.push('Court address');
  if (!has((property && property.court_phone) || (court && court.phone))) gaps.push('Court telephone number');
  return gaps;
}

// What the Illinois notices need and the property does not yet carry. Shown on the
// admin screen so the gaps are filled before a notice goes out rather than after
// somebody reads a row of underscores on a served letter.
function ilMissingFields(property) {
  const want = [
    ['legal_description', 'Legal description'],
    ['pin', 'PIN'],
    ['memo_recorded_county', 'Recorded county'],
    ['memo_recorded_date', 'Recording date'],
    ['memo_document_no', 'Recording document number'],
    ['escrow_agent', 'Escrow agent'],
    ['court_district', 'Circuit court'],
  ];
  return want.filter(([k]) => !(property && String(property[k] || '').trim())).map(([, label]) => label);
}

module.exports = { initSchema, seedLadder, rulesFor, defaultWording, dueRule, DEFAULT_LADDER,
  isMichigan, miCourtFor, MI_COURTS, MI_NON_WAIVER, MI_PARTIAL_NON_WAIVER, miLateNoticeWording,
  miMissingFields, isIllinois, IL_LADDER, IL_PREP_DAY, IL_FILE_DAY, IL_CONTRACT_CURE_DAYS, IL_FORFEIT_CURE_DAYS,
  ilDefaultWording, ilForfeitureWording, ilFiveDayWording, ilMissingFields };
