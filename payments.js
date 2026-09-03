// Payment integrations: Stripe Checkout (card / ACH / Cash App Pay) + cash-at-retail slips.
// Stripe is called via its REST API directly (no SDK needed). Set STRIPE_SECRET_KEY to enable.
// admin when cash is received.

const crypto = require('crypto');
const { get, run } = require('./db');

// Like texting and mail, Stripe is the company's own account first and the host's
// environment second — a servicer connects their key in Settings without touching the
// deployment. Every function takes an optional company and falls back to the env.
let ACTIVE_COMPANY = null;                       // set per-request by withCompany below
const STRIPE_KEY = (company) => {
  const co = company || ACTIVE_COMPANY;
  return (co && co.stripe_secret_key) || process.env.STRIPE_SECRET_KEY || '';
};
const stripeEnabled = (company) => !!STRIPE_KEY(company);
// Run fn with this company's credentials active for every Stripe call inside it.
async function withCompany(company, fn) {
  const prev = ACTIVE_COMPANY;
  ACTIVE_COMPANY = company || null;
  try { return await fn(); } finally { ACTIVE_COMPANY = prev; }
}

async function stripeRequest(pathname, params) {
  const body = new URLSearchParams();
  const flatten = (obj, prefix = '') => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (Array.isArray(v)) v.forEach((item, i) => {
        if (typeof item === 'object') flatten(item, `${key}[${i}]`);
        else body.append(`${key}[${i}]`, item);
      });
      else if (v !== null && typeof v === 'object') flatten(v, key);
      else if (v !== undefined) body.append(key, v);
    }
  };
  flatten(params);
  const res = await fetch(`https://api.stripe.com/v1/${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_KEY()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ? json.error.message : `Stripe error ${res.status}`);
  return json;
}

// Create a Stripe Checkout session for a loan payment.
// The session is restricted to the method the buyer chose, because the fee was quoted
// for that method. Offering all three here while charging the card rate meant a buyer who
// picked bank transfer paid the card fee — tens of dollars more than the transfer cost.
async function createCheckoutSession({ loan, amountCents, baseUrl, tenantEmail, feeCents, feeLabel, method }) {
  const methods = method === 'ach' ? ['us_bank_account']
    : method === 'cashapp' ? ['cashapp']
    : ['card'];
  const feeLines = feeCents ? {
    'line_items[1][price_data][currency]': 'usd',
    'line_items[1][price_data][unit_amount]': feeCents,
    'line_items[1][price_data][product_data][name]': feeLabel || 'Processing fee',
    'line_items[1][quantity]': 1,
  } : {};
  return stripeRequest('checkout/sessions', {
    mode: 'payment',
    payment_method_types: methods,
    customer_email: tenantEmail,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': amountCents,
    'line_items[0][price_data][product_data][name]': `Loan payment — ${loan.address}`,
    'line_items[0][quantity]': 1,
    ...feeLines,
    'metadata[loan_id]': loan.id,
    'metadata[amount_cents]': amountCents,
    'metadata[fee_cents]': feeCents || 0,
    // The success URL is a server route on purpose. A buyer paying from the installed
    // app gets bounced through their external browser, where no session cookie exists —
    // so the landing must not need one. The server verifies the session with Stripe
    // directly and posts the payment before the buyer even sees the confirmation.
    success_url: `${baseUrl}/api/pay/landing?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/?paid=0`,
  });
}

// Recent checkout sessions, straight from Stripe — the reconciliation sweep walks
// these and posts anything the webhook missed. Idempotent downstream by external_id.
async function listRecentSessions(limit = 100) {
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions?limit=${Math.min(100, limit)}&status=complete`, {
    headers: { Authorization: `Bearer ${STRIPE_KEY()}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ? json.error.message : `Stripe error ${res.status}`);
  return json.data || [];
}

// Expands the charge so the caller can read which method the buyer actually used.
// session.payment_method_types is the list we ALLOW, not the one they picked — and card
// is first in it, so reading [0] labelled every payment "Card", bank transfers included.
async function retrieveSession(sessionId) {
  const q = 'expand[]=payment_intent.latest_charge';
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}?${q}`, {
    headers: { Authorization: `Bearer ${STRIPE_KEY()}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ? json.error.message : `Stripe error ${res.status}`);
  return json;
}

// Verify a Stripe webhook signature (Stripe-Signature header, v1 scheme).
function verifyStripeSignature(payload, sigHeader, secret, toleranceSec = 300) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  } catch { return false; }
}

// ---- Saved payment methods (tokenized — we never touch card or bank numbers) ----
// Flow: create/reuse a Stripe Customer -> open Checkout in "setup" mode -> Stripe stores
// the card or bank account and hands back a payment_method id we can charge later.

async function getOrCreateCustomer(user, saveIdFn) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const c = await stripeRequest('customers', {
    email: user.email, name: user.name,
    'metadata[user_id]': user.id,
  });
  if (saveIdFn) saveIdFn(c.id);
  return c.id;
}

// Checkout session that saves a payment method instead of charging.
async function createSetupSession({ customerId, baseUrl, methods }) {
  return stripeRequest('checkout/sessions', {
    mode: 'setup',
    customer: customerId,
    payment_method_types: methods || ['card', 'us_bank_account'],
    success_url: `${baseUrl}/?saved=1&setup_session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/?saved=0`,
  });
}

async function stripeGet(pathname) {
  const res = await fetch(`https://api.stripe.com/v1/${pathname}`, {
    headers: { Authorization: `Bearer ${STRIPE_KEY()}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ? json.error.message : `Stripe error ${res.status}`);
  return json;
}

async function retrieveSetupIntent(id) { return stripeGet(`setup_intents/${id}`); }
async function retrievePaymentMethod(id) { return stripeGet(`payment_methods/${id}`); }

async function listCustomerPaymentMethods(customerId) {
  const out = [];
  for (const type of ['card', 'us_bank_account']) {
    const r = await stripeGet(`payment_methods?customer=${customerId}&type=${type}&limit=20`);
    out.push(...(r.data || []));
  }
  return out;
}

async function detachPaymentMethod(pmId) {
  return stripeRequest(`payment_methods/${pmId}/detach`, {});
}

// Charge a saved method without the buyer present (autopay, or one-tap repeat payment).
async function chargeSavedMethod({ customerId, paymentMethodId, amountCents, description, idempotencyKey }) {
  const body = new URLSearchParams({
    amount: String(amountCents),
    currency: 'usd',
    customer: customerId,
    payment_method: paymentMethodId,
    off_session: 'true',
    confirm: 'true',
    description: description || 'Loan payment',
  });
  const headers = {
    Authorization: `Bearer ${STRIPE_KEY()}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST', headers, body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ? json.error.message : `Stripe error ${res.status}`);
  return json;
}

// ---- Financial Connections: link business bank / card accounts for expense import ----
async function createFinancialConnectionsSession({ customerId, baseUrl }) {
  return stripeRequest('financial_connections/sessions', {
    'account_holder[type]': 'customer',
    'account_holder[customer]': customerId,
    'permissions[0]': 'transactions',
    'permissions[1]': 'balances',
    'permissions[2]': 'ownership',
    return_url: `${baseUrl}/admin?linked=1`,
  });
}
async function listFinancialAccounts(sessionId) {
  const s = await stripeGet(`financial_connections/sessions/${sessionId}`);
  return s.accounts && s.accounts.data ? s.accounts.data : [];
}
async function refreshAccountTransactions(accountId) {
  return stripeRequest(`financial_connections/accounts/${accountId}/refresh`, { features: 'transactions' });
}
async function listAccountTransactions(accountId, limit = 100) {
  const r = await stripeGet(`financial_connections/transactions?account=${accountId}&limit=${limit}`);
  return r.data || [];
}

module.exports = { withCompany, stripeEnabled, createCheckoutSession, retrieveSession, listRecentSessions, verifyStripeSignature,
  getOrCreateCustomer, createSetupSession, retrieveSetupIntent, retrievePaymentMethod,
  listCustomerPaymentMethods, detachPaymentMethod, chargeSavedMethod,
  createFinancialConnectionsSession, listFinancialAccounts,
  refreshAccountTransactions, listAccountTransactions };
