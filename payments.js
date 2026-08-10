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
async function createCheckoutSession({ loan, amountCents, baseUrl, tenantEmail }) {
  const methods = ['card', 'cashapp', 'us_bank_account'];
  return stripeRequest('checkout/sessions', {
    mode: 'payment',
    payment_method_types: methods,
    customer_email: tenantEmail,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': amountCents,
    'line_items[0][price_data][product_data][name]': `Loan payment — ${loan.address}`,
    'line_items[0][quantity]': 1,
    'metadata[loan_id]': loan.id,
    'metadata[amount_cents]': amountCents,
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

module.exports = { stripeEnabled, createCheckoutSession, retrieveSession, verifyStripeSignature,
  createRetailSlip, pnmEnabled, verifyPnmSignature };
