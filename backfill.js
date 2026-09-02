// One-time migration of the four old money tables into the double-entry journal.
//
// Runs itself on boot when the journal is empty and there is existing data, so nothing
// has to be run by hand on the server. It is idempotent — every entry carries an
// idempotency key derived from its source row, so a second run posts nothing.
//
// The old tables are left exactly as they are. Nothing reads from the journal yet, so
// if the reconciliation at the end does not come out clean, the app carries on working
// off the old tables and no harm is done.
//
// Opening balances are offset against Owner Equity. That is the ordinary way to open a
// new set of books: you are not restating history, you are stating where things stood
// on the day the journal starts.

const { get, all, run } = require('./db');
const J = require('./journal');

const today = () => new Date().toISOString().slice(0, 10);

// property_costs.category and expenses.category -> account.
// Anything that adds lasting value to the house is capitalised into basis rather than
// expensed, because it is part of what the house cost you, not what it costs to hold.
const COST_ACCOUNT = {
  purchase: '1400', closing: '1400', filing: '1400', rehab: '1400',
  bog: '5220', insurance: '5210', taxes: '5200', utilities: '5230',
  marketing: '5250', legal: '5240', servicing_fee: '5900', hoa: '5900',
  repairs: '5220', other: '5900',
};
const acctForCategory = (c) => COST_ACCOUNT[String(c || 'other').toLowerCase()] || '5900';

function alreadyDone(key) {
  return !!get('SELECT id FROM journal_entries WHERE idempotency_key=?', key);
}

// ---------- tenant buyer loans ----------
function migrateLoan(loan, report) {
  const co = loan.company_id;
  const prop = loan.property_id;
  const buyer = loan.tenant_user_id;   // needed to name whose escrow it is
  const base = { company_id: co, property_id: prop, loan_id: loan.id };

  // Opening: the note as originally written.
  const openKey = `bf:loan:${loan.id}:open`;
  if (!alreadyDone(openKey) && loan.principal_cents > 0) {
    J.postEntry({
      ...base, date: loan.first_payment_date || today(),
      description: `Opening balance — note receivable`,
      source_type: 'opening_balance', source_id: loan.id, idempotency_key: openKey,
      lines: [
        { account: '1200', debit: loan.principal_cents },
        { account: '3000', credit: loan.principal_cents },
      ],
    });
  }

  const rows = all('SELECT * FROM ledger WHERE loan_id=? ORDER BY entry_date, id', loan.id);
  for (const r of rows) {
    const key = `bf:ledger:${r.id}`;
    if (alreadyDone(key)) continue;
    // A payment that has not cleared is not money the books have received. It is on
    // the ledger as initiated and belongs in the journal only once it lands.
    if (r.status === 'pending' || r.status === 'returned') continue;
    const common = { ...base, date: r.entry_date, source_type: 'payment',
                     source_id: r.id, idempotency_key: key,
                     description: r.memo || `${r.type} (migrated)` };

    if (r.type === 'payment') {
      const toPrincipal = r.to_principal_cents || 0;
      const toInterest  = r.to_interest_cents || 0;
      const toEscrow    = r.to_escrow_cents || 0;
      const toFees      = r.to_fees_cents || 0;
      const allocated   = toPrincipal + toInterest + toEscrow + toFees;
      const cash        = r.amount_cents || 0;
      // Anything the old row did not allocate lands in Unapplied rather than being
      // quietly dropped — a difference you can see beats a difference you cannot.
      const unapplied   = cash - allocated;

      const lines = [];
      const operatingCash = cash - toEscrow;
      if (operatingCash !== 0) {
        lines.push(operatingCash > 0
          ? { account: '1010', debit: operatingCash }
          : { account: '1010', credit: -operatingCash });
      }
      if (toEscrow > 0) {
        if (buyer) {
          lines.push({ account: '1015', debit: toEscrow, beneficiary_user_id: buyer });
          lines.push({ account: '2100', credit: toEscrow, beneficiary_user_id: buyer });
        } else {
          // No buyer on the loan, so it cannot be held in trust for anyone.
          lines.push({ account: '1010', debit: toEscrow });
          lines.push({ account: '2150', credit: toEscrow });
          report.warnings.push(`Loan ${loan.id} ledger ${r.id}: escrow with no buyer on the loan — parked in Unapplied`);
        }
      }
      if (toPrincipal) lines.push({ account: '1200', credit: toPrincipal });
      if (toInterest)  lines.push({ account: '4100', credit: toInterest });
      if (toFees)      lines.push({ account: '4200', credit: toFees });
      if (unapplied > 0) lines.push({ account: '2150', credit: unapplied });
      if (unapplied < 0) lines.push({ account: '2150', debit: -unapplied });

      if (lines.length >= 2) J.postEntry({ ...common, lines });

    } else if (r.type === 'late_fee' || r.type === 'fee') {
      // A charge assessed, not cash received.
      const amt = Math.abs(r.amount_cents || 0);
      if (amt) J.postEntry({ ...common, source_type: 'fee', lines: [
        { account: '1250', debit: amt },
        { account: r.type === 'late_fee' ? '4200' : '4300', credit: amt },
      ]});

    } else if (r.type === 'escrow_disbursement') {
      const amt = Math.abs(r.amount_cents || 0);
      if (amt && buyer) J.postEntry({ ...common, source_type: 'escrow_disbursement', lines: [
        { account: '2100', debit: amt, beneficiary_user_id: buyer },
        { account: '1015', credit: amt, beneficiary_user_id: buyer },
      ]});
      else if (amt) report.warnings.push(`Loan ${loan.id} ledger ${r.id}: escrow disbursement with no buyer — skipped`);

    } else if (r.type === 'adjustment') {
      const amt = r.amount_cents || 0;
      if (amt) J.postEntry({ ...common, source_type: 'manual', lines: amt > 0
        ? [{ account: '1010', debit: amt }, { account: '3000', credit: amt }]
        : [{ account: '3000', debit: -amt }, { account: '1010', credit: -amt }] });
    }
    // 'note' rows carry no money and are left where they are.
  }
}

// ---------- private money lender loans ----------
function migratePml(pml, report) {
  const base = { company_id: pml.company_id, property_id: pml.property_id, pml_loan_id: pml.id };

  const openKey = `bf:pml:${pml.id}:open`;
  if (!alreadyDone(openKey) && pml.principal_cents > 0) {
    J.postEntry({
      ...base, date: pml.first_payment_date || today(),
      description: `Opening balance — ${pml.lender_name || 'lender'} note payable`,
      source_type: 'opening_balance', source_id: pml.id, idempotency_key: openKey,
      lines: [
        { account: '3000', debit: pml.principal_cents },
        { account: '2200', credit: pml.principal_cents },
      ],
    });
  }

  const rows = all('SELECT * FROM pml_ledger WHERE pml_loan_id=? ORDER BY entry_date, id', pml.id);
  for (const r of rows) {
    const key = `bf:pmlledger:${r.id}`;
    if (alreadyDone(key)) continue;
    const common = { ...base, date: r.entry_date, source_id: r.id, idempotency_key: key,
                     description: r.memo || `${r.type} to ${pml.lender_name || 'lender'} (migrated)` };
    const amt = Math.abs(r.amount_cents || 0);
    if (!amt) continue;

    if (r.type === 'payment') {
      const toPrincipal = r.to_principal_cents || 0;
      const toInterest  = r.to_interest_cents || 0;
      const other = amt - toPrincipal - toInterest;
      const lines = [];
      if (toPrincipal) lines.push({ account: '2200', debit: toPrincipal });
      if (toInterest)  lines.push({ account: '5100', debit: toInterest });
      if (other > 0)   lines.push({ account: '5900', debit: other });
      if (other < 0)   lines.push({ account: '5900', credit: -other });
      lines.push({ account: '1010', credit: amt });
      if (lines.length >= 2) J.postEntry({ ...common, source_type: 'pml_payment', lines });

    } else if (r.type === 'draw') {
      J.postEntry({ ...common, source_type: 'pml_payment', lines: [
        { account: '1010', debit: amt }, { account: '2200', credit: amt } ]});

    } else if (r.type === 'fee') {
      J.postEntry({ ...common, source_type: 'fee', lines: [
        { account: '5900', debit: amt }, { account: '1010', credit: amt } ]});

    } else if (r.type === 'adjustment') {
      const signed = r.amount_cents || 0;
      J.postEntry({ ...common, source_type: 'manual', lines: signed > 0
        ? [{ account: '3000', debit: signed }, { account: '2200', credit: signed }]
        : [{ account: '2200', debit: -signed }, { account: '3000', credit: -signed }] });
    }
  }
}

// ---------- what the house cost, and what it costs to hold ----------
function migrateCosts(companyId, report) {
  for (const c of all('SELECT * FROM property_costs WHERE company_id=?', companyId)) {
    const key = `bf:cost:${c.id}`;
    if (alreadyDone(key) || !c.amount_cents) continue;
    J.postEntry({
      company_id: companyId, property_id: c.property_id,
      date: c.cost_date || today(),
      description: c.description || 'Property cost (migrated)',
      source_type: 'cost', source_id: c.id, idempotency_key: key,
      lines: [
        { account: acctForCategory(c.category), debit: Math.abs(c.amount_cents) },
        { account: '3000', credit: Math.abs(c.amount_cents) },
      ],
    });
  }

  for (const e of all(
      "SELECT * FROM expenses WHERE company_id=? AND status='assigned' AND property_id IS NOT NULL",
      companyId)) {
    const key = `bf:expense:${e.id}`;
    if (alreadyDone(key) || !e.amount_cents) continue;
    J.postEntry({
      company_id: companyId, property_id: e.property_id,
      date: e.txn_date || today(),
      description: e.description || 'Expense (migrated)',
      source_type: 'expense', source_id: e.id, idempotency_key: key,
      lines: [
        { account: acctForCategory(e.category), debit: Math.abs(e.amount_cents) },
        { account: '3000', credit: Math.abs(e.amount_cents) },
      ],
    });
  }
}

// ---------- why does it not come out right? ----------
// A number that does not match is only half the story, and the half that does not help.
// Every difference this migration can produce has a small number of causes, and each
// one leaves a signature in the data. So rather than reporting a delta and leaving
// somebody to work backwards from it, work out which cause fits and say so.
//
// The causes, in the order they are tested:
//
//   seasoned_loan   The journal opens each loan at principal_cents — the note as
//                   originally written — and then subtracts only the payments recorded
//                   in this app. A contract taken over mid-life has years of payments
//                   that happened before the app existed and are nowhere in the ledger,
//                   so the journal still shows the original balance. The tell is that
//                   the difference equals exactly what was paid down before the ledger
//                   starts, and the loan opened with a balance below its note.
//
//   unapplied_escrow  postPayment folds unapplied money into the buyer's escrow
//                   balance; the journal puts it in Unapplied Funds, because it is not
//                   escrow and trust money has to be somebody's. Both are defensible
//                   and they cannot agree. The tell is a difference equal to the
//                   unapplied total on the loan.
//
//   unsplit_ledger  A payment row with no allocation on it. The journal cannot guess
//                   how it should have been divided, so the whole amount lands in
//                   Unapplied and principal never moves.
//
//   edited_balance  principal_balance_cents and escrow_balance_cents can both be typed
//                   in directly on the loan edit screen. Nothing records that, so a
//                   hand-corrected balance drifts from the replay permanently.
//
//   unknown         Nothing above fits. Worth a look by hand.
const CAUSE_TEXT = {
  seasoned_loan: 'This loan carries less principal than its note, by more than the payments ' +
    'recorded here account for. Usually that means the contract was taken over part-way through: ' +
    'the journal opens at the original note amount and knows nothing about payments made before ' +
    'this app existed. It can also mean the balance was corrected by hand at some point — nothing ' +
    'records that, so the two look identical from here. Either way the fix is the same: open the ' +
    'journal at the balance as it stood when these records begin.',
  unapplied_escrow: 'Money that arrived without being allocated. The app adds it to the escrow ' +
    'balance; the journal holds it in Unapplied Funds, because it is not really escrow and trust ' +
    'money has to be held for a named person. One of the two has to give — the amounts are right ' +
    'either way.',
  unsplit_ledger: 'One or more payments were recorded without a split between principal, interest, ' +
    'escrow and fees. The journal will not guess, so it parked the whole amount in Unapplied and ' +
    'the principal never came down. Splitting those payments fixes it.',
  edited_balance: 'This balance was typed in rather than reached by payments, so the journal — ' +
    'which only replays what actually happened — lands somewhere else. The journal figure is the ' +
    'one the history supports.',
  unknown: 'No familiar cause fits this one. Worth opening the loan and comparing the ledger ' +
    'against the journal entries line by line.',
};

// Everything about one loan the cause test needs, gathered in a single pass.
function loanEvidence(loanId) {
  const e = get(`SELECT
      COUNT(*)                                                      AS rows_total,
      COALESCE(SUM(CASE WHEN type='payment' THEN 1 ELSE 0 END), 0)  AS payments,
      COALESCE(SUM(CASE WHEN type='payment' AND COALESCE(to_principal_cents,0)=0
                         AND COALESCE(to_interest_cents,0)=0
                         AND COALESCE(to_escrow_cents,0)=0
                         AND COALESCE(to_fees_cents,0)=0
                    THEN 1 ELSE 0 END), 0)                          AS unsplit_rows,
      COALESCE(SUM(CASE WHEN type='payment'
                    THEN COALESCE(amount_cents,0)
                       - COALESCE(to_principal_cents,0) - COALESCE(to_interest_cents,0)
                       - COALESCE(to_escrow_cents,0)   - COALESCE(to_fees_cents,0)
                    ELSE 0 END), 0)                                 AS unapplied_cents,
      COALESCE(SUM(COALESCE(to_principal_cents,0)), 0)              AS paid_principal_cents
    FROM ledger WHERE loan_id=?`, loanId);
  return e || { rows_total: 0, payments: 0, unsplit_rows: 0, unapplied_cents: 0, paid_principal_cents: 0 };
}

function diagnosePrincipal(loan, diff, ev) {
  // Order matters, and it is not the obvious one. An unsplit payment row leaves the
  // loan looking exactly like a seasoned one — principal below the note, journal above
  // the app — because in both cases principal never came down. The difference is that
  // an unsplit row is a defect you can point at and fix, while "taken over part-way
  // through" is an inference from the shape of the numbers. So the provable cause is
  // tested first. Split the payments, run this again, and any remaining difference is
  // then honestly the seasoned-loan opening.
  if (ev.unsplit_rows > 0) return 'unsplit_ledger';

  // The journal is above the app by what was paid off before this app's ledger begins,
  // and the loan says so itself by having opened below its own note.
  //
  // Worth being straight about the limit here: a loan opened below its note and a loan
  // whose balance was typed down by hand leave identical traces. Nothing records that
  // an edit happened, so no test can separate them, and a confident wrong label is
  // worse than an honest ambiguous one — the cause text names both possibilities.
  const openedBelowNote = loan.principal_cents > 0
    && loan.principal_balance_cents + ev.paid_principal_cents < loan.principal_cents;
  if (diff > 0 && openedBelowNote) return 'seasoned_loan';

  // The other direction is not ambiguous. The journal below the app means the loan is
  // carrying more principal than its note ever created, which payments cannot do.
  if (diff < 0) return 'edited_balance';

  return 'unknown';
}

function diagnoseEscrow(loan, diff, ev) {
  // An unsplit row's whole amount counts as unapplied, so the two tests overlap here
  // as well. Unapplied money that came from a properly split payment is the accounting
  // disagreement; unapplied money that exists only because nobody split the row is a
  // data problem wearing the same clothes.
  if (ev.unsplit_rows > 0 && ev.unapplied_cents === 0) return 'unsplit_ledger';
  if (ev.unapplied_cents !== 0) return 'unapplied_escrow';
  if (ev.unsplit_rows > 0) return 'unsplit_ledger';
  if (ev.payments === 0 && diff !== 0) return 'edited_balance';
  return 'unknown';
}

// ---------- did it come out right? ----------
// Compares what the journal now says against what the old tables say. Any row that is
// not zero is a real discrepancy and worth understanding before anything reads from
// the journal.
function reconcile(companyId) {
  const loans = [];
  for (const l of all('SELECT * FROM loans WHERE company_id=?', companyId)) {
    const jPrincipal = J.balance('1200', { loan_id: l.id });
    const jEscrow    = J.balance('2100', { loan_id: l.id });
    const principalDiff = jPrincipal - l.principal_balance_cents;
    const escrowDiff    = jEscrow - l.escrow_balance_cents;
    const ev = (principalDiff || escrowDiff) ? loanEvidence(l.id) : null;
    const principalCause = principalDiff ? diagnosePrincipal(l, principalDiff, ev) : null;
    const escrowCause    = escrowDiff ? diagnoseEscrow(l, escrowDiff, ev) : null;
    loans.push({
      loan_id: l.id,
      principal_old: l.principal_balance_cents,
      principal_journal: jPrincipal,
      principal_diff: principalDiff,
      principal_cause: principalCause,
      principal_because: principalCause ? CAUSE_TEXT[principalCause] : null,
      escrow_old: l.escrow_balance_cents,
      escrow_journal: jEscrow,
      escrow_diff: escrowDiff,
      escrow_cause: escrowCause,
      escrow_because: escrowCause ? CAUSE_TEXT[escrowCause] : null,
      // The workings, so a number that looks wrong can be checked rather than trusted.
      evidence: ev ? {
        note_cents: l.principal_cents,
        opened_at_cents: l.principal_balance_cents + ev.paid_principal_cents,
        payments_recorded: ev.payments,
        payments_unsplit: ev.unsplit_rows,
        unapplied_cents: ev.unapplied_cents,
        principal_paid_here_cents: ev.paid_principal_cents,
      } : null,
    });
  }
  const pmls = [];
  for (const p of all('SELECT * FROM pml_loans WHERE company_id=?', companyId)) {
    const jP = J.balance('2200', { pml_loan_id: p.id });
    const diff = jP - p.principal_balance_cents;
    // A lender note has the same shape of problem: taken on part-way through, or its
    // balance typed in. There is no allocation split to go wrong, so the test is
    // simply whether any payments were recorded here at all.
    const paid = get(`SELECT COUNT(*) c FROM pml_ledger WHERE pml_loan_id=?`, p.id).c;
    const cause = !diff ? null
      : (diff > 0 && p.principal_cents > p.principal_balance_cents) ? 'seasoned_loan'
      : paid === 0 ? 'edited_balance'
      : 'unknown';
    pmls.push({
      pml_loan_id: p.id,
      lender_name: p.lender_name || null,
      principal_old: p.principal_balance_cents,
      principal_journal: jP,
      principal_diff: diff,
      principal_cause: cause,
      principal_because: cause ? CAUSE_TEXT[cause] : null,
    });
  }
  const tb = J.trialBalance(companyId);
  const trust = J.trustCheck(companyId);
  const clean = tb.balanced && trust.balanced
    && loans.every(r => r.principal_diff === 0 && r.escrow_diff === 0)
    && pmls.every(r => r.principal_diff === 0);

  // Four accounts off for one reason is one problem; four off for four reasons is four.
  // The grouping is the first thing worth knowing, so it comes back already done.
  const byCause = new Map();
  const note = (cause, label, diff) => {
    if (!cause) return;
    if (!byCause.has(cause)) byCause.set(cause, { cause, why: CAUSE_TEXT[cause], accounts: [], total_cents: 0 });
    const g = byCause.get(cause);
    g.accounts.push(label);
    g.total_cents += Math.abs(diff);
  };
  for (const l of loans) {
    note(l.principal_cause, `Buyer loan #${l.loan_id} principal`, l.principal_diff);
    note(l.escrow_cause, `Buyer loan #${l.loan_id} escrow`, l.escrow_diff);
  }
  for (const p of pmls) {
    note(p.principal_cause, `Lender loan #${p.pml_loan_id}${p.lender_name ? ` (${p.lender_name})` : ''}`, p.principal_diff);
  }

  return {
    clean, trial_balance: tb, trust, loans, pmls,
    causes: [...byCause.values()].sort((a, b) => b.accounts.length - a.accounts.length),
    off_count: loans.filter(l => l.principal_diff || l.escrow_diff).length
             + pmls.filter(p => p.principal_diff).length,
  };
}

// ---------- entry point ----------
function run_backfill({ force = false } = {}) {
  const companies = all('SELECT * FROM companies');
  const out = [];
  for (const co of companies) {
    const existing = get('SELECT COUNT(*) c FROM journal_entries WHERE company_id=?', co.id).c;
    const hasOld = get('SELECT COUNT(*) c FROM ledger').c
      + get('SELECT COUNT(*) c FROM pml_ledger').c
      + get('SELECT COUNT(*) c FROM property_costs WHERE company_id=?', co.id).c;
    if (existing > 0 && !force) { out.push({ company_id: co.id, skipped: 'already migrated' }); continue; }
    if (!hasOld) { out.push({ company_id: co.id, skipped: 'nothing to migrate' }); continue; }

    const report = { company_id: co.id, warnings: [] };
    try {
      for (const l of all('SELECT * FROM loans WHERE company_id=?', co.id)) migrateLoan(l, report);
      for (const p of all('SELECT * FROM pml_loans WHERE company_id=?', co.id)) migratePml(p, report);
      migrateCosts(co.id, report);
      report.reconciliation = reconcile(co.id);
      report.ok = report.reconciliation.clean;
    } catch (e) {
      report.ok = false;
      report.error = e.message;
    }
    out.push(report);
  }
  return out;
}

// Run on boot, quietly, and say plainly whether the books came out clean.
function maybeRunOnBoot() {
  try {
    const reports = run_backfill();
    for (const r of reports) {
      if (r.skipped) continue;
      if (r.error) { console.error(`Journal backfill failed for company ${r.company_id}: ${r.error}`); continue; }
      const rec = r.reconciliation;
      const bad = [...rec.loans.filter(l => l.principal_diff || l.escrow_diff),
                   ...rec.pmls.filter(p => p.principal_diff)];
      console.log(r.ok
        ? `Journal backfill complete for company ${r.company_id} — books balance and every loan reconciles.`
        : `Journal backfill for company ${r.company_id} finished with ${bad.length} loan(s) not reconciling. ` +
          `Old tables are still in charge; nothing is broken. See Settings → Books.`);
      for (const w of r.warnings) console.log(`  note: ${w}`);
    }
  } catch (e) {
    console.error('Journal backfill error:', e.message);
  }
}

module.exports = { run_backfill, reconcile, maybeRunOnBoot, acctForCategory };
