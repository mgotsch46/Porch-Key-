// Financial reporting for a seller-finance portfolio.
//
// The accounting model, stated plainly so the numbers are defensible:
//
//  * You buy a house with cash plus private money, fix it, then sell it on a land
//    contract. After the sale you are a NOTE HOLDER, not a landlord.
//  * Buyer principal received is NOT income — it is return of capital on the note.
//    Only interest and fees hit the P&L.
//  * PML principal you repay is NOT an expense — it retires a liability. Only the
//    interest you pay is an expense.
//  * Escrow you collect is not yours; it is a liability until disbursed.
//  * Gain on sale is shown separately. Land contracts commonly qualify for
//    installment-sale treatment, so the whole gain usually is not taxable in year
//    one — that is a question for your CPA, and this report does not decide it.

const { get, all } = require('./db');

const money = (n) => Math.round(n || 0);

// ---------- helpers ----------
function periodClause(col, from, to) {
  const parts = [];
  const args = [];
  if (from) { parts.push(`${col} >= ?`); args.push(from); }
  if (to)   { parts.push(`${col} <= ?`); args.push(to); }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', args };
}

function propertyCostTotal(propertyId) {
  return get('SELECT COALESCE(SUM(amount_cents),0) s FROM property_costs WHERE property_id=?', propertyId).s;
}
function propertyAssignedExpenses(propertyId) {
  return get("SELECT COALESCE(SUM(amount_cents),0) s FROM expenses WHERE property_id=? AND status='assigned'", propertyId).s;
}
// Everything a lender has actually advanced: original principal plus later draws.
function pmlAdvanced(propertyId) {
  const loans = all('SELECT * FROM pml_loans WHERE property_id=?', propertyId);
  let advanced = 0, balance = 0, interestPaid = 0, principalPaid = 0;
  for (const pl of loans) {
    const draws = get("SELECT COALESCE(SUM(amount_cents),0) s FROM pml_ledger WHERE pml_loan_id=? AND type='draw'", pl.id).s;
    const paid = get(`SELECT COALESCE(SUM(to_interest_cents),0) i, COALESCE(SUM(to_principal_cents),0) p
      FROM pml_ledger WHERE pml_loan_id=? AND type='payment'`, pl.id);
    advanced += pl.principal_cents + draws;
    balance += pl.principal_balance_cents;
    interestPaid += paid.i;
    principalPaid += paid.p;
  }
  return { advanced, balance, interestPaid, principalPaid, count: loans.length };
}

// ---------- income statement ----------
function profitAndLoss(companyId, from, to) {
  const pc = periodClause('l.entry_date', from, to);

  // Revenue — buyer payments split by where the money was applied.
  const collected = get(`SELECT
      COALESCE(SUM(l.to_interest_cents),0)  AS interest,
      COALESCE(SUM(l.to_principal_cents),0) AS principal,
      COALESCE(SUM(l.to_escrow_cents),0)    AS escrow,
      COALESCE(SUM(l.to_fees_cents),0)      AS fees,
      COALESCE(SUM(l.fee_cents),0)          AS processing_fees_collected
    FROM ledger l JOIN loans ln ON ln.id=l.loan_id
    WHERE ln.company_id=? AND l.type='payment'${pc.sql}`, companyId, ...pc.args);

  // Fees assessed but not necessarily collected (late fees, recurring charges).
  const assessed = get(`SELECT COALESCE(SUM(ABS(l.amount_cents)),0) s
    FROM ledger l JOIN loans ln ON ln.id=l.loan_id
    WHERE ln.company_id=? AND l.type IN ('late_fee','fee')${pc.sql}`, companyId, ...pc.args);

  // Expenses — money out of pocket on properties.
  const ec = periodClause('cost_date', from, to);
  const costs = all(`SELECT category, COALESCE(SUM(amount_cents),0) total
    FROM property_costs WHERE company_id=?${ec.sql} GROUP BY category`, companyId, ...ec.args);
  const costBy = {};
  for (const c of costs) costBy[c.category] = c.total;

  const xc = periodClause('txn_date', from, to);
  const importedExpenses = get(`SELECT COALESCE(SUM(amount_cents),0) s FROM expenses
    WHERE company_id=? AND status='assigned'${xc.sql}`, companyId, ...xc.args).s;

  // Interest paid to private lenders.
  const lc = periodClause('pl.entry_date', from, to);
  const lenderInterest = get(`SELECT COALESCE(SUM(pl.to_interest_cents),0) s
    FROM pml_ledger pl JOIN pml_loans p ON p.id=pl.pml_loan_id
    WHERE p.company_id=? AND pl.type='payment'${lc.sql}`, companyId, ...lc.args).s;

  // Operating costs exclude the capitalized purchase price — that sits on the
  // balance sheet until the house sells, then flows through cost of sale.
  const operating = {
    rehab: costBy.rehab || 0,
    bog: costBy.bog || 0,
    filing: costBy.filing || 0,
    insurance: costBy.insurance || 0,
    taxes: costBy.taxes || 0,
    utilities: costBy.utilities || 0,
    marketing: costBy.marketing || 0,
    legal: costBy.legal || 0,
    closing: costBy.closing || 0,
    other: costBy.other || 0,
    imported: importedExpenses,
  };
  const operatingTotal = Object.values(operating).reduce((a, b) => a + b, 0);

  const revenue = {
    interest_income: collected.interest,
    fee_income: collected.fees,
    total_cents: collected.interest + collected.fees,
  };
  const expenses = {
    lender_interest: lenderInterest,
    ...operating,
    total_cents: operatingTotal + lenderInterest,
  };

  // Gain on the houses that sold in the window (sale price less everything in them).
  const sc = periodClause('created_at', from, to);
  const sold = all(`SELECT * FROM loans WHERE company_id=?${sc.sql}`, companyId, ...sc.args);
  let gainOnSale = 0;
  const sales = [];
  for (const l of sold) {
    const basis = propertyCostTotal(l.property_id) + propertyAssignedExpenses(l.property_id);
    const gain = l.sale_price_cents - basis;
    gainOnSale += gain;
    const prop = get('SELECT address FROM properties WHERE id=?', l.property_id);
    sales.push({ loan_id: l.id, address: prop ? prop.address : '',
      sale_price_cents: l.sale_price_cents, basis_cents: basis, gain_cents: gain });
  }

  return {
    period: { from: from || null, to: to || null },
    revenue,
    expenses,
    net_operating_income_cents: revenue.total_cents - expenses.total_cents,
    gain_on_sale_cents: gainOnSale,
    sales,
    net_income_cents: revenue.total_cents - expenses.total_cents + gainOnSale,
    memo: {
      principal_collected_cents: collected.principal,
      escrow_collected_cents: collected.escrow,
      fees_assessed_cents: assessed.s,
      processing_fees_collected_cents: collected.processing_fees_collected,
    },
  };
}

// ---------- balance sheet ----------
function balanceSheet(companyId, asOf) {
  const notesReceivable = get(`SELECT COALESCE(SUM(principal_balance_cents),0) s
    FROM loans WHERE company_id=? AND status='active'`, companyId).s;

  const props = all('SELECT * FROM properties WHERE company_id=?', companyId);
  let heldAtCost = 0;
  const held = [];
  for (const p of props) {
    const sold = get("SELECT id FROM loans WHERE property_id=? AND status='active'", p.id);
    if (sold) continue;
    const basis = propertyCostTotal(p.id) + propertyAssignedExpenses(p.id);
    heldAtCost += basis;
    held.push({ id: p.id, address: p.address, basis_cents: basis, status: p.status });
  }

  const escrowHeld = get(`SELECT COALESCE(SUM(escrow_balance_cents),0) s
    FROM loans WHERE company_id=? AND status='active'`, companyId).s;

  const lenderDebt = get(`SELECT COALESCE(SUM(principal_balance_cents),0) s
    FROM pml_loans WHERE company_id=? AND status='active'`, companyId).s;

  const assets = {
    notes_receivable_cents: notesReceivable,
    properties_held_at_cost_cents: heldAtCost,
    total_cents: notesReceivable + heldAtCost,
  };
  const liabilities = {
    lender_notes_payable_cents: lenderDebt,
    escrow_held_for_buyers_cents: escrowHeld,
    total_cents: lenderDebt + escrowHeld,
  };
  return {
    as_of: asOf || new Date().toISOString().slice(0, 10),
    assets, liabilities,
    equity_cents: assets.total_cents - liabilities.total_cents,
    properties_held: held,
  };
}

// ---------- returns: cash-on-cash and ROI ----------
// Cash in the deal = everything you spent, less what a lender advanced, less the
// buyer's down payment, plus any lender principal you have since repaid out of pocket.
function propertyReturns(companyId, propertyId) {
  const p = get('SELECT * FROM properties WHERE id=? AND company_id=?', propertyId, companyId);
  if (!p) return null;

  const costs = propertyCostTotal(p.id);
  const assigned = propertyAssignedExpenses(p.id);
  const allIn = costs + assigned;

  const pml = pmlAdvanced(p.id);
  const loan = get("SELECT * FROM loans WHERE property_id=? ORDER BY id DESC LIMIT 1", p.id);
  const down = loan ? loan.down_payment_cents : 0;

  const cashInvested = allIn - pml.advanced - down + pml.principalPaid;

  // Cash actually collected from the buyer, and cash paid to lenders.
  let collected = { interest: 0, principal: 0, fees: 0, escrow: 0 };
  let firstPaymentDate = null, lastPaymentDate = null;
  if (loan) {
    const c = get(`SELECT COALESCE(SUM(to_interest_cents),0) i, COALESCE(SUM(to_principal_cents),0) p,
        COALESCE(SUM(to_fees_cents),0) f, COALESCE(SUM(to_escrow_cents),0) e,
        MIN(entry_date) first_d, MAX(entry_date) last_d
      FROM ledger WHERE loan_id=? AND type='payment'`, loan.id);
    collected = { interest: c.i, principal: c.p, fees: c.f, escrow: c.e };
    firstPaymentDate = c.first_d; lastPaymentDate = c.last_d;
  }
  const lenderPaid = pml.interestPaid + pml.principalPaid;

  // Trailing twelve months of actual cash movement.
  const cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  let ttmIn = 0, ttmOut = 0;
  if (loan) {
    const t = get(`SELECT COALESCE(SUM(to_interest_cents + to_principal_cents + to_fees_cents),0) s
      FROM ledger WHERE loan_id=? AND type='payment' AND entry_date >= ?`, loan.id, cutoff);
    ttmIn = t.s;
  }
  const tOut = get(`SELECT COALESCE(SUM(pl.amount_cents),0) s FROM pml_ledger pl
    JOIN pml_loans p2 ON p2.id=pl.pml_loan_id
    WHERE p2.property_id=? AND pl.type='payment' AND pl.entry_date >= ?`, p.id, cutoff);
  const tCosts = get(`SELECT COALESCE(SUM(amount_cents),0) s FROM property_costs
    WHERE property_id=? AND cost_date >= ? AND category NOT IN ('purchase','closing','rehab')`, p.id, cutoff);
  ttmOut = tOut.s + tCosts.s;
  const ttmCashFlow = ttmIn - ttmOut;

  // Forward run rate from the contracted payments, which is what most investors quote.
  let annualRunRate = 0;
  if (loan && loan.status === 'active') {
    const pmlMonthly = all("SELECT payment_cents FROM pml_loans WHERE property_id=? AND status='active'", p.id)
      .reduce((t, x) => t + x.payment_cents, 0);
    annualRunRate = (loan.payment_cents - pmlMonthly) * 12;
  }

  const totalCashIn = collected.interest + collected.principal + collected.fees + down;
  const totalCashOut = allIn + lenderPaid - pml.advanced;
  const netProfitToDate = totalCashIn - totalCashOut;

  // How long the money has been at work, for annualizing.
  const start = p.acquired_date || (loan ? loan.first_payment_date : null);
  let yearsHeld = null;
  if (start) {
    yearsHeld = Math.max(0.08, (Date.now() - new Date(start + 'T00:00:00Z').getTime()) / (365 * 86400000));
  }

  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 100 : null);

  return {
    property_id: p.id, address: p.address, status: p.status,
    all_in_cents: allIn,
    lender_advanced_cents: pml.advanced,
    lender_balance_cents: pml.balance,
    down_payment_cents: down,
    cash_invested_cents: cashInvested,
    collected,
    total_cash_in_cents: totalCashIn,
    total_cash_out_cents: totalCashOut,
    net_profit_to_date_cents: netProfitToDate,
    ttm_cash_flow_cents: ttmCashFlow,
    annual_run_rate_cents: annualRunRate,
    note_balance_cents: loan ? loan.principal_balance_cents : 0,
    sale_price_cents: loan ? loan.sale_price_cents : 0,
    years_held: yearsHeld ? Math.round(yearsHeld * 100) / 100 : null,
    // Cash-on-cash: annual pre-tax cash flow divided by cash still in the deal.
    cash_on_cash_ttm_pct: pct(ttmCashFlow, cashInvested),
    cash_on_cash_run_rate_pct: pct(annualRunRate, cashInvested),
    // ROI: total profit earned to date on the cash you put in.
    roi_to_date_pct: pct(netProfitToDate, cashInvested),
    annualized_roi_pct: yearsHeld && cashInvested > 0
      ? Math.round((netProfitToDate / cashInvested / yearsHeld) * 10000) / 100 : null,
    infinite_return: cashInvested <= 0,
    first_payment_date: firstPaymentDate, last_payment_date: lastPaymentDate,
  };
}

function portfolioReturns(companyId) {
  const props = all('SELECT id FROM properties WHERE company_id=?', companyId);
  const rows = props.map(p => propertyReturns(companyId, p.id)).filter(Boolean);
  const sum = (k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
  const cashInvested = sum('cash_invested_cents');
  const ttm = sum('ttm_cash_flow_cents');
  const runRate = sum('annual_run_rate_cents');
  const profit = sum('net_profit_to_date_cents');
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 100 : null);
  return {
    properties: rows,
    totals: {
      count: rows.length,
      all_in_cents: sum('all_in_cents'),
      cash_invested_cents: cashInvested,
      lender_balance_cents: sum('lender_balance_cents'),
      note_balance_cents: sum('note_balance_cents'),
      ttm_cash_flow_cents: ttm,
      annual_run_rate_cents: runRate,
      net_profit_to_date_cents: profit,
      cash_on_cash_ttm_pct: pct(ttm, cashInvested),
      cash_on_cash_run_rate_pct: pct(runRate, cashInvested),
      roi_to_date_pct: pct(profit, cashInvested),
    },
  };
}

module.exports = { profitAndLoss, balanceSheet, propertyReturns, portfolioReturns, money };
