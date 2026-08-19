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

// ---------- did it come out right? ----------
// Compares what the journal now says against what the old tables say. Any row that is
// not zero is a real discrepancy and worth understanding before anything reads from
// the journal.
function reconcile(companyId) {
  const loans = [];
  for (const l of all('SELECT * FROM loans WHERE company_id=?', companyId)) {
    const jPrincipal = J.balance('1200', { loan_id: l.id });
    const jEscrow    = J.balance('2100', { loan_id: l.id });
    loans.push({
      loan_id: l.id,
      principal_old: l.principal_balance_cents,
      principal_journal: jPrincipal,
      principal_diff: jPrincipal - l.principal_balance_cents,
      escrow_old: l.escrow_balance_cents,
      escrow_journal: jEscrow,
      escrow_diff: jEscrow - l.escrow_balance_cents,
    });
  }
  const pmls = [];
  for (const p of all('SELECT * FROM pml_loans WHERE company_id=?', companyId)) {
    const jP = J.balance('2200', { pml_loan_id: p.id });
    pmls.push({
      pml_loan_id: p.id,
      principal_old: p.principal_balance_cents,
      principal_journal: jP,
      principal_diff: jP - p.principal_balance_cents,
    });
  }
  const tb = J.trialBalance(companyId);
  const trust = J.trustCheck(companyId);
  const clean = tb.balanced && trust.balanced
    && loans.every(r => r.principal_diff === 0 && r.escrow_diff === 0)
    && pmls.every(r => r.principal_diff === 0);
  return { clean, trial_balance: tb, trust, loans, pmls };
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
