// Loan servicing engine: amortization, due amounts, payment allocation, payoff.
// All money is integer cents. Rates are basis points (950 = 9.50% APR).

const MS_DAY = 86400000;

function monthlyRate(bps) { return bps / 10000 / 12; }

// Standard amortizing payment for principal P, monthly rate r, n months.
function calcPayment(principalCents, rateBps, termMonths) {
  const r = monthlyRate(rateBps);
  if (r === 0) return Math.ceil(principalCents / termMonths);
  const p = principalCents * (r * Math.pow(1 + r, termMonths)) / (Math.pow(1 + r, termMonths) - 1);
  return Math.round(p);
}

// Full amortization schedule from original terms.
function amortizationSchedule(loan) {
  const r = monthlyRate(loan.interest_rate_bps);
  let bal = loan.principal_cents;
  const rows = [];
  let date = new Date(loan.first_payment_date + 'T00:00:00Z');
  for (let n = 1; n <= loan.term_months && bal > 0; n++) {
    const interest = Math.round(bal * r);
    let principal = loan.payment_cents - interest;
    if (principal > bal) principal = bal; // final payment
    bal -= principal;
    rows.push({
      n,
      date: date.toISOString().slice(0, 10),
      payment_cents: interest + principal,
      interest_cents: interest,
      principal_cents: principal,
      balance_cents: bal,
    });
    date = addMonthsUTC(date, 1);
  }
  return rows;
}

function addMonthsUTC(d, m) {
  const nd = new Date(d);
  const day = nd.getUTCDate();
  nd.setUTCDate(1);
  nd.setUTCMonth(nd.getUTCMonth() + m);
  const last = new Date(Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth() + 1, 0)).getUTCDate();
  nd.setUTCDate(Math.min(day, last));
  return nd;
}

// How many scheduled payments have come due as of `asOf` (inclusive of due date).
function paymentsDue(loan, asOf) {
  const first = new Date(loan.first_payment_date + 'T00:00:00Z');
  const now = new Date(asOf + 'T00:00:00Z');
  if (now < first) return 0;
  let months = (now.getUTCFullYear() - first.getUTCFullYear()) * 12 + (now.getUTCMonth() - first.getUTCMonth());
  const dueThisMonth = addMonthsUTC(first, months);
  if (now >= dueThisMonth) months += 1;
  return Math.min(months, loan.term_months);
}

function nextDueDate(loan, asOf) {
  const n = paymentsDue(loan, asOf);
  const first = new Date(loan.first_payment_date + 'T00:00:00Z');
  if (n >= loan.term_months) return null;
  return addMonthsUTC(first, n).toISOString().slice(0, 10);
}

// Current status: amount owed now (past-due scheduled payments + fees minus what's been paid).
function loanStatus(loan, ledgerRows, asOf) {
  const due = paymentsDue(loan, asOf);
  const scheduledDueCents = due * (loan.payment_cents + loan.escrow_cents);
  const paidCents = ledgerRows
    .filter(l => l.type === 'payment')
    .reduce((s, l) => s + (l.to_interest_cents + l.to_principal_cents + l.to_escrow_cents + l.to_fees_cents), 0);
  const feesAssessed = ledgerRows
    .filter(l => l.type === 'late_fee' || l.type === 'fee')
    .reduce((s, l) => s + Math.abs(l.amount_cents), 0);
  const feesPaid = ledgerRows.filter(l => l.type === 'payment').reduce((s, l) => s + l.to_fees_cents, 0);
  const owedNow = Math.max(0, scheduledDueCents + feesAssessed - paidCents);
  const paymentsMade = Math.floor(
    ledgerRows.filter(l => l.type === 'payment')
      .reduce((s, l) => s + l.to_interest_cents + l.to_principal_cents, 0) / Math.max(1, loan.payment_cents)
  );
  return {
    payments_due: due,
    owed_now_cents: owedNow,
    fees_due_cents: Math.max(0, feesAssessed - feesPaid),
    next_due_date: nextDueDate(loan, asOf),
    is_past_due: owedNow > 0 && due > 0,
    payments_made_equiv: paymentsMade,
  };
}

// Allocate a received amount: fees -> interest accrued -> escrow (current month) -> principal.
// Interest accrues monthly on outstanding principal at the note rate.
function allocatePayment(loan, amountCents, asOf) {
  let remaining = amountCents;
  const r = monthlyRate(loan.interest_rate_bps);

  // 1. Fees
  const toFees = Math.min(remaining, loan.fees_due_cents);
  remaining -= toFees;

  // 2. Interest: carried interest_due + one month's interest per payment period being covered.
  //    For simple servicing we charge one month of interest per payment cycle.
  let interestOwed = loan.interest_due_cents;
  if (interestOwed === 0) {
    interestOwed = Math.round(loan.principal_balance_cents * r);
  }
  const toInterest = Math.min(remaining, interestOwed);
  remaining -= toInterest;

  // 3. Escrow
  const toEscrow = Math.min(remaining, loan.escrow_cents);
  remaining -= toEscrow;

  // 4. Principal
  const toPrincipal = Math.min(remaining, loan.principal_balance_cents);
  remaining -= toPrincipal;

  return {
    to_fees_cents: toFees,
    to_interest_cents: toInterest,
    to_escrow_cents: toEscrow,
    to_principal_cents: toPrincipal,
    unapplied_cents: remaining, // overpayment beyond payoff — goes to escrow credit
    interest_shortfall_cents: Math.max(0, interestOwed - toInterest),
  };
}

// 10-day payoff quote: principal + accrued interest (per diem) + fees - escrow credit.
function payoffQuote(loan, asOf) {
  const perDiem = loan.principal_balance_cents * (loan.interest_rate_bps / 10000) / 365;
  const days = 10;
  const accrued = Math.round(perDiem * days) + loan.interest_due_cents;
  return {
    good_through: new Date(new Date(asOf + 'T00:00:00Z').getTime() + days * MS_DAY).toISOString().slice(0, 10),
    principal_cents: loan.principal_balance_cents,
    interest_cents: accrued,
    fees_cents: loan.fees_due_cents,
    escrow_credit_cents: loan.escrow_balance_cents,
    total_cents: Math.max(0, loan.principal_balance_cents + accrued + loan.fees_due_cents - loan.escrow_balance_cents),
  };
}

module.exports = { calcPayment, amortizationSchedule, paymentsDue, nextDueDate, loanStatus, allocatePayment, payoffQuote, addMonthsUTC };
