// Loan servicing engine: amortization, due amounts, payment allocation, payoff.
// All money is integer cents. Rates are basis points (950 = 9.50% APR), and they are
// allowed to be fractional — 712.345 bps is 7.12345% — because notes are written with
// rates like that and a payment computed from a rounded rate does not tie out to the
// note. Every formula here divides the rate straight through, so precision survives;
// only money is ever rounded, and only to cents.

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
    // The last scheduled payment settles whatever is left. A fixed, rounded payment
    // never lands exactly on zero, so the final one absorbs the few dollars of
    // rounding drift — which is how the note actually pays off.
    if (principal > bal || n === loan.term_months) principal = bal;
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

// The next payment owed is the oldest UNPAID installment — not the next one on the
// calendar. Deriving it from paymentsDue alone means the date skips past an unpaid
// installment the moment its due date arrives (a buyer who missed Sept was shown
// "next due Oct 1" on Sept 1, beside "past due"), and never advances for a buyer who
// has paid ahead. When no ledger count is supplied the old schedule-only behaviour
// stands, which is what the PML trackers want — they have a schedule and no ledger.
function nextDueDate(loan, asOf, paymentsMade) {
  const n = Number.isFinite(paymentsMade) ? paymentsMade : paymentsDue(loan, asOf);
  const first = new Date(loan.first_payment_date + 'T00:00:00Z');
  if (n >= loan.term_months) return null;
  return addMonthsUTC(first, n).toISOString().slice(0, 10);
}

// A payment counts only once the money has actually arrived. An ACH debit sits as
// 'pending' for up to four business days and can be returned after that, so counting it
// early would tell a buyer they are current and quietly stop the notice ladder on a
// default that is still running. Rows written before this existed have no status and
// were final when they were taken, so a missing value reads as cleared.
const isCleared = (l) => l.type === 'payment' && (l.status || 'cleared') === 'cleared';

// Current status: amount owed now (past-due scheduled payments + fees minus what's been paid).
function loanStatus(loan, ledgerRows, asOf) {
  const due = paymentsDue(loan, asOf);
  const scheduledDueCents = due * (loan.payment_cents + loan.escrow_cents);
  const paidCents = ledgerRows
    .filter(isCleared)
    .reduce((s, l) => s + (l.to_interest_cents + l.to_principal_cents + l.to_escrow_cents + l.to_fees_cents), 0);
  const feesAssessed = ledgerRows
    .filter(l => l.type === 'late_fee' || l.type === 'fee')
    .reduce((s, l) => s + Math.abs(l.amount_cents), 0);
  const feesPaid = ledgerRows.filter(isCleared).reduce((s, l) => s + l.to_fees_cents, 0);
  const owedNow = Math.max(0, scheduledDueCents + feesAssessed - paidCents);
  const paymentsMade = Math.floor(
    ledgerRows.filter(isCleared)
      .reduce((s, l) => s + l.to_interest_cents + l.to_principal_cents, 0) / Math.max(1, loan.payment_cents)
  );
  // Money the buyer has sent that has not landed yet. Shown to them so a payment in
  // flight is visible, and never counted against what is owed.
  const pendingCents = ledgerRows
    .filter(l => l.type === 'payment' && l.status === 'pending')
    .reduce((s, l) => s + l.amount_cents, 0);
  return {
    payments_due: due,
    owed_now_cents: owedNow,
    fees_due_cents: Math.max(0, feesAssessed - feesPaid),
    next_due_date: nextDueDate(loan, asOf, paymentsMade),
    is_past_due: owedNow > 0 && due > 0,
    payments_made_equiv: paymentsMade,
    pending_cents: pendingCents,
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

// ---------- solve for the missing variable ----------
// Give any three of principal, rate, term and payment; get the fourth. Same idea as
// the SOLVE key on a financial calculator.

// Principal you can finance at a given payment, rate and term.
function calcPrincipal(paymentCents, rateBps, termMonths) {
  const r = monthlyRate(rateBps);
  if (!paymentCents || !termMonths) return 0;
  if (r === 0) return Math.round(paymentCents * termMonths);
  // The payment is a rounded cent figure, so a range of principals all produce it.
  // Take the raw figure, then nudge to the nearest whole dollar that reproduces the
  // payment exactly — that is the number the user actually typed in.
  const raw = paymentCents * (1 - Math.pow(1 + r, -termMonths)) / r;
  const base = Math.round(raw / 100) * 100;
  for (const candidate of [base, base + 100, base - 100, base + 200, base - 200]) {
    if (candidate > 0 && calcPayment(candidate, rateBps, termMonths) === paymentCents) return candidate;
  }
  return base;
}

// Months needed to clear the balance at that payment. Returns null when the payment
// never covers the interest — the loan would grow forever.
function calcTerm(principalCents, paymentCents, rateBps) {
  const r = monthlyRate(rateBps);
  if (!principalCents || !paymentCents) return null;
  if (r === 0) return Math.ceil(principalCents / paymentCents);
  const monthlyInterest = principalCents * r;
  if (paymentCents <= monthlyInterest) return null;
  const n = -Math.log(1 - (r * principalCents) / paymentCents) / Math.log(1 + r);
  // The payment is a rounded cent figure, so n lands a hair either side of the real
  // term. Snap to the whole month when we are within a rounding error of it.
  const nearest = Math.round(n);
  return Math.abs(n - nearest) < 0.02 ? nearest : Math.ceil(n);
}

// Rate implied by a principal, payment and term. No closed form exists, so bisect.
function calcRate(principalCents, paymentCents, termMonths) {
  if (!principalCents || !paymentCents || !termMonths) return null;
  if (paymentCents * termMonths <= principalCents) return 0;   // no interest is being charged
  let lo = 0, hi = 10000;                                       // 0% to 100% APR in basis points
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const pay = calcPayment(principalCents, mid, termMonths);
    if (pay > paymentCents) hi = mid; else lo = mid;
  }
  // Round to a thousandth of a basis point (5 decimals of percent) — finer than that
  // is noise, since the payment it came from was already rounded to a cent.
  const bps = Math.round(((lo + hi) / 2) * 1000) / 1000;
  return bps > 9990 ? null : bps;                               // out of a believable range
}

// Solves whichever field was left blank and returns the full picture.
function solveLoan({ principal_cents, payment_cents, interest_rate_bps, term_months, first_payment_date }) {
  const has = (v) => v !== null && v !== undefined && v !== '' && Number(v) > 0;
  let principal = has(principal_cents) ? Number(principal_cents) : null;
  let payment = has(payment_cents) ? Number(payment_cents) : null;
  let rate = (interest_rate_bps !== null && interest_rate_bps !== undefined && interest_rate_bps !== '')
    ? Number(interest_rate_bps) : null;
  let term = has(term_months) ? Number(term_months) : null;

  let solvedFor = null, error = null;
  const known = [principal !== null, payment !== null, rate !== null, term !== null].filter(Boolean).length;
  if (known < 3) {
    error = 'Fill in any three of principal, rate, term and payment and I will work out the fourth.';
  } else if (payment === null) {
    payment = calcPayment(principal, rate, term); solvedFor = 'payment';
  } else if (principal === null) {
    principal = calcPrincipal(payment, rate, term); solvedFor = 'principal';
  } else if (term === null) {
    term = calcTerm(principal, payment, rate); solvedFor = 'term';
    if (term === null) error = 'That payment does not cover the monthly interest, so the loan would never pay off.';
  } else if (rate === null) {
    rate = calcRate(principal, payment, term); solvedFor = 'rate';
    if (rate === null) error = 'No sensible interest rate fits those numbers — check the payment and term.';
  } else {
    solvedFor = 'nothing';   // all four given; we just verify and show the schedule
  }

  if (error) return { error, solved_for: solvedFor };

  const loan = {
    principal_cents: Math.round(principal), payment_cents: Math.round(payment),
    // The rate the user gave is kept exactly as given — rounding it here would make
    // the payment stop matching the note. Only trim float noise past 5 decimals.
    interest_rate_bps: Math.round(rate * 1000) / 1000, term_months: Math.round(term),
    first_payment_date: first_payment_date || new Date().toISOString().slice(0, 10),
    escrow_cents: 0,
  };
  const schedule = amortizationSchedule(loan);
  const totalInterest = schedule.reduce((t, row) => t + row.interest_cents, 0);
  const totalPaid = schedule.reduce((t, row) => t + row.payment_cents, 0);
  const last = schedule[schedule.length - 1];

  return {
    solved_for: solvedFor,
    principal_cents: loan.principal_cents,
    payment_cents: loan.payment_cents,
    interest_rate_bps: loan.interest_rate_bps,
    term_months: loan.term_months,
    first_payment_date: loan.first_payment_date,
    final_payment_date: last ? last.date : null,
    total_interest_cents: totalInterest,
    total_paid_cents: totalPaid,
    schedule,
  };
}

// The date the last scheduled payment lands.
function finalPaymentDate(firstPaymentDate, termMonths) {
  if (!firstPaymentDate || !termMonths) return null;
  const first = new Date(firstPaymentDate + 'T00:00:00Z');
  return addMonthsUTC(first, Number(termMonths) - 1).toISOString().slice(0, 10);
}

// Months between a first and last payment date, inclusive.
function termFromDates(firstPaymentDate, finalDate) {
  if (!firstPaymentDate || !finalDate) return null;
  const a = new Date(firstPaymentDate + 'T00:00:00Z'), b = new Date(finalDate + 'T00:00:00Z');
  if (b < a) return null;
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  return months + 1;
}

// Roll a monthly schedule into calendar years — how most people want to read it.
function yearlySchedule(schedule) {
  const years = new Map();
  for (const row of schedule) {
    const y = row.date.slice(0, 4);
    if (!years.has(y)) {
      years.set(y, { year: y, payments: 0, payment_cents: 0, interest_cents: 0,
        principal_cents: 0, balance_cents: row.balance_cents, first_n: row.n, last_n: row.n });
    }
    const b = years.get(y);
    b.payments += 1;
    b.payment_cents += row.payment_cents;
    b.interest_cents += row.interest_cents;
    b.principal_cents += row.principal_cents;
    b.balance_cents = row.balance_cents;   // balance at the end of that year
    b.last_n = row.n;
  }
  return [...years.values()];
}


// The same schedule, with money added on top of the required payment. Extra money goes
// straight to principal — there is no interest owed beyond what the balance accrues —
// so the note pays off early and the interest that would have accrued on the retired
// balance is never charged. extra_monthly_cents rides on every payment; extra_once is a
// list of { month_n, amount_cents } one-time payments applied with that month's payment.
function scheduleWithExtras(loan, { extra_monthly_cents = 0, extra_once = [] } = {}) {
  const onceBy = {};
  for (const e of extra_once || []) {
    const n = Number(e.month_n), amt = Math.round(Number(e.amount_cents) || 0);
    if (n >= 1 && amt > 0) onceBy[n] = (onceBy[n] || 0) + amt;
  }
  const extraMonthly = Math.max(0, Math.round(Number(extra_monthly_cents) || 0));
  const r = monthlyRate(loan.interest_rate_bps);
  let bal = loan.principal_cents;
  const rows = [];
  let date = new Date(loan.first_payment_date + 'T00:00:00Z');
  for (let n = 1; n <= loan.term_months && bal > 0; n++) {
    const interest = Math.round(bal * r);
    let principal = loan.payment_cents - interest + extraMonthly + (onceBy[n] || 0);
    if (principal > bal || n === loan.term_months) principal = bal;
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

module.exports = { calcPayment, calcPrincipal, calcTerm, calcRate, solveLoan, yearlySchedule, scheduleWithExtras,
  finalPaymentDate, termFromDates, amortizationSchedule, paymentsDue, nextDueDate, loanStatus, allocatePayment, payoffQuote, addMonthsUTC };
