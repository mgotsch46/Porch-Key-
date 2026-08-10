// Payment integrations: Stripe Checkout (card / ACH / Cash App Pay) + cash-at-retail slips.
// Stripe is called via its REST API directly (no SDK needed). Set STRIPE_SECRET_KEY to enable.
// Cash-at-retail (Walmart / 7-Eleven) works through PayNearMe-style slips: the app issues a
// payment code; once you have a PayNearMe (or Green Dot @ Retail) merchant account, plug the
// API call into createRetailSlip() where marked. Until then, slips can be marked paid by the
// admin when cash is received.

const crypto = require('crypto');
const { get, run } = require('./db');

const STRIPE_KEY = () => process.env.STRIPE_SECRET_KEY || '';
const stripeEnabled = () => !!STRIPE_KEY();

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
async function createCheckoutSession({ loan, amountCents, baseUrl, tenantEmail, feeCents, feeLabel }) {
  const methods = ['card', 'cashapp', 'us_bank_account'];
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
    success_url: `${baseUrl}/?paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/?paid=0`,
  });
}

async function retrieveSession(sessionId) {
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
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

// ---- Cash at retail via PayNearMe (Walmart, 7-Eleven, CVS, Dollar General, Walgreens...) ----
// Set PNM_API_KEY, PNM_SITE_ID (and optionally PNM_BASE_URL) once your merchant account is
// approved and slips will be created through PayNearMe with a real scannable barcode; their
// webhook then posts payments automatically. Without those vars the app issues internal
// codes the admin marks paid manually — same buyer experience, manual confirmation.
const PNM_BASE = () => process.env.PNM_BASE_URL || 'https://api.paynearme.com/v2';
const pnmEnabled = () => !!(process.env.PNM_API_KEY && process.env.PNM_SITE_ID);

async function pnmRequest(pathname, params) {
  const body = new URLSearchParams({ site_identifier: process.env.PNM_SITE_ID, ...params });
  const res = await fetch(`${PNM_BASE()}/${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${process.env.PNM_SITE_ID}:${process.env.PNM_API_KEY}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_message || json.error || `PayNearMe error ${res.status}`);
  return json;
}

// Creates a cash payment order. Returns the local slip row (with barcode_url when live).
async function createRetailSlip(loanId, amountCents, tenant, daysValid = 30) {
  const expires = new Date(Date.now() + daysValid * 86400000).toISOString().slice(0, 10);
  let code = 'CP-' + crypto.randomInt(0, 1e10).toString().padStart(10, '0');
  let barcodeUrl = null;

  if (pnmEnabled()) {
    try {
      // PayNearMe "order" — site_customer_identifier ties the payment back to this loan.
      const order = await pnmRequest('order/create', {
        site_customer_identifier: `loan-${loanId}`,
        site_order_identifier: code,
        order_amount: (amountCents / 100).toFixed(2),
        order_currency: 'USD',
        customer_name: (tenant && tenant.name) || '',
        customer_email: (tenant && tenant.email) || '',
        customer_phone: (tenant && tenant.phone) || '',
        order_expiration_date: expires,
      });
      if (order.payment_identifier) code = order.payment_identifier;
      barcodeUrl = order.barcode_url || order.payment_url || null;
    } catch (e) {
      console.error('PayNearMe order failed, falling back to internal code:', e.message);
    }
  }

  run('INSERT INTO cash_slips (slip_code, loan_id, amount_cents, expires_at, barcode_url) VALUES (?,?,?,?,?)',
    code, loanId, amountCents, expires, barcodeUrl);
  return get('SELECT * FROM cash_slips WHERE slip_code = ?', code);
}

// Verify a PayNearMe webhook signature (HMAC-SHA256 of the raw body with your secret).
function verifyPnmSignature(payload, sigHeader, secret) {
  if (!secret) return true;           // no secret configured — accept (dev)
  if (!sigHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sigHeader))); }
  catch { return false; }
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

module.exports = { stripeEnabled, createCheckoutSession, retrieveSession, verifyStripeSignature,
  createRetailSlip, pnmEnabled, verifyPnmSignature,
  getOrCreateCustomer, createSetupSession, retrieveSetupIntent, retrievePaymentMethod,
  listCustomerPaymentMethods, detachPaymentMethod, chargeSavedMethod,
  createFinancialConnectionsSession, listFinancialAccounts,
  refreshAccountTransactions, listAccountTransactions };
