// Message templates: merge fields, HTML sanitising, and the branded shell every
// piece of correspondence goes out in.
//
// Branding rule, applied everywhere: the servicing company's name and logo lead the
// message — buyers are dealing with them, not with us. A small "Powered by Porch Pay"
// line sits at the bottom.

const { get, all, run } = require('./db');

// ---------- merge fields ----------
// Everything an admin can drop into a template, with a plain-English description.
const MERGE_FIELDS = [
  { key: 'first_name',        label: "Buyer's first name",        example: 'Jane' },
  { key: 'buyer_name',        label: "Buyer's full name",         example: 'Jane Buyer' },
  { key: 'property_address',  label: 'Property address',          example: '123 Oak St' },
  { key: 'company_name',      label: 'Your company name',         example: 'RenewEQ' },
  { key: 'balance',           label: 'Current loan balance',      example: '$98,450.12' },
  { key: 'monthly_payment',   label: 'Monthly payment',           example: '$840.85' },
  { key: 'amount_due',        label: 'Amount due right now',      example: '$840.85' },
  { key: 'due_date',          label: 'Next due date',             example: 'Sep 1, 2026' },
  { key: 'late_fee',          label: 'Late fee on this loan',     example: '$50.00' },
  { key: 'grace_days',        label: 'Grace period in days',      example: '5' },
  { key: 'interest_rate',     label: 'Interest rate',             example: '9.50%' },
  { key: 'payoff_amount',     label: 'Estimated payoff',          example: '$99,120.00' },
  { key: 'app_link',          label: 'Link to the buyer app',     example: 'https://…' },
  { key: 'rep_name',          label: 'Your representative name',  example: 'Marisa Gotsch' },
  { key: 'rep_phone',         label: 'Representative phone',      example: '(555) 555-5555' },
  { key: 'mgmt_company',      label: 'Management company name',   example: 'RenewEQ Management' },
];

const money = (c) => '$' + ((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const niceDate = (d) => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

function buildMergeValues({ company, buyer, loan, property, status, payoff, baseUrl }) {
  const full = (buyer && buyer.name) || '';
  return {
    first_name: full.trim().split(/\s+/)[0] || 'there',
    buyer_name: full,
    property_address: (property && property.address) || 'your home',
    company_name: (company && company.name) || 'Your servicer',
    balance: loan ? money(loan.principal_balance_cents) : '',
    monthly_payment: loan ? money(loan.payment_cents + loan.escrow_cents) : '',
    amount_due: status ? money(status.owed_now_cents) : '',
    due_date: status ? niceDate(status.next_due_date) : '',
    late_fee: loan ? money(loan.late_fee_cents) : '',
    grace_days: loan ? String(loan.grace_days) : '',
    interest_rate: loan ? (loan.interest_rate_bps / 100).toFixed(2) + '%' : '',
    payoff_amount: payoff ? money(payoff.total_cents) : '',
    app_link: (baseUrl || '') + '/',
    rep_name: (company && company.rep_name) || '',
    rep_phone: (company && company.rep_phone) || '',
    mgmt_company: (company && (company.mgmt_company_name || company.name)) || '',
  };
}

function applyMerge(text, values) {
  if (!text) return '';
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : m);
}

// ---------- sanitising ----------
// Admin-authored HTML still gets cleaned. A compromised or careless staff account
// should not be able to run script inside a buyer's app.
const ALLOWED_TAGS = new Set(['p','br','b','strong','i','em','u','a','ul','ol','li','h1','h2','h3','h4',
  'blockquote','hr','span','div','table','thead','tbody','tr','td','th','img','small','code','pre']);

function sanitizeHtml(html) {
  if (!html) return '';
  let out = String(html);
  out = out.replace(/<\s*(script|style|iframe|object|embed|form|input|button|link|meta)[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  out = out.replace(/<\s*(script|style|iframe|object|embed|form|input|button|link|meta)\b[^>]*\/?>/gi, '');
  out = out.replace(/\son\w+\s*=\s*"[^"]*"/gi, '').replace(/\son\w+\s*=\s*'[^']*'/gi, '')
           .replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
  out = out.replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
  out = out.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (tag, name, attrs) => {
    if (!ALLOWED_TAGS.has(name.toLowerCase())) return '';
    return tag;
  });
  return out;
}

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- branded shell ----------
// Company identity on top, Porch Pay small at the bottom, on every message.
// Who to call and where to write, on the bottom of every piece of correspondence.
function contactBlock(company) {
  if (!company) return '';
  const bits = [];
  if (company.rep_name) bits.push(`<b>${escapeHtml(company.rep_name)}</b>`);
  if (company.rep_phone) bits.push(escapeHtml(company.rep_phone));
  if (company.contact_email) bits.push(escapeHtml(company.contact_email));
  const addr = [company.mailing_address,
    [company.mailing_city, company.mailing_state].filter(Boolean).join(', '),
    company.mailing_zip].filter(Boolean).join(' · ');
  if (!bits.length && !addr) return '';
  return `<div class="pp-contact">
    ${bits.length ? `<div>${bits.join(' · ')}</div>` : ''}
    ${addr ? `<div>${escapeHtml(addr)}</div>` : ''}
  </div>`;
}

function brandedShell({ company, bodyHtml, subject, baseUrl }) {
  const name = escapeHtml((company && company.name) || 'Your servicer');
  const logo = company && company.logo_path
    ? `${baseUrl || ''}/api/company-logo/${company.id}`
    : `${baseUrl || ''}/logo-mark.png`;
  return `<div class="pp-letter">
  <div class="pp-letterhead">
    <img src="${logo}" alt="" class="pp-colog">
    <div class="pp-coname">${name}</div>
  </div>
  ${subject ? `<div class="pp-subject">${escapeHtml(subject)}</div>` : ''}
  <div class="pp-body">${bodyHtml}</div>
  ${contactBlock(company)}
  <div class="pp-footer">
    <img src="${baseUrl || ''}/logo-mark.png" alt="" class="pp-ppmark">
    <span>Sent through <b>Porch Pay</b></span>
  </div>
</div>`;
}

// Plain-text version for SMS and anywhere HTML would be wrong.
function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-4]|li|tr)\s*>/gi, '\n')
    .replace(/<\s*li\s*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- starter templates ----------
// Seeded once per company so the library is never an empty screen.
const STARTERS = [
  {
    name: 'Welcome to your new home',
    category: 'welcome',
    subject: 'Welcome home, {{first_name}}',
    body_html: `<p>Hi {{first_name}},</p>
<p>Congratulations on {{property_address}}. We're glad to have you.</p>
<p>Everything about your loan lives in this app — your balance, your payment schedule, your documents, and a direct line to us.</p>
<ul>
  <li><b>Your balance:</b> {{balance}}</li>
  <li><b>Monthly payment:</b> {{monthly_payment}}</li>
  <li><b>First payment due:</b> {{due_date}}</li>
</ul>
<p>You can pay by card, bank transfer, Cash App, or cash at a participating store. If anything is ever unclear, message us right here.</p>
<p>— {{company_name}}</p>`,
  },
  {
    name: 'Payment reminder',
    category: 'reminder',
    subject: 'Your payment is due {{due_date}}',
    body_html: `<p>Hi {{first_name}},</p>
<p>A friendly reminder that your payment of <b>{{monthly_payment}}</b> for {{property_address}} is due on <b>{{due_date}}</b>.</p>
<p>You can pay in the app in under a minute. If you've already sent it, thank you — please ignore this note.</p>
<p>— {{company_name}}</p>`,
  },
  {
    name: 'Payment received — thank you',
    category: 'receipt',
    subject: 'Thanks — we received your payment',
    body_html: `<p>Hi {{first_name}},</p>
<p>Your payment has been received and applied to your loan on {{property_address}}.</p>
<p>Your balance is now <b>{{balance}}</b>. Your next payment of {{monthly_payment}} is due {{due_date}}.</p>
<p>Thank you.</p>
<p>— {{company_name}}</p>`,
  },
  {
    name: 'Past due — friendly first notice',
    category: 'late',
    subject: 'We haven’t received your payment yet',
    body_html: `<p>Hi {{first_name}},</p>
<p>We haven't received your payment of <b>{{amount_due}}</b> for {{property_address}}, which was due {{due_date}}.</p>
<p>Your agreement allows a {{grace_days}}-day grace period, after which a late fee of {{late_fee}} may apply.</p>
<p>If money is tight this month, please message us — it's always easier to work something out early than late.</p>
<p>— {{company_name}}</p>`,
  },
  {
    name: 'Annual escrow / insurance update',
    category: 'notice',
    subject: 'An update about your taxes and insurance',
    body_html: `<p>Hi {{first_name}},</p>
<p>We're writing with an update on the taxes and insurance for {{property_address}}.</p>
<p><i>[Replace this paragraph with the details — new premium, new tax amount, and what it means for the monthly payment.]</i></p>
<p>The updated documents are in your Documents tab under Insurance and Taxes.</p>
<p>— {{company_name}}</p>`,
  },
  {
    name: 'Payoff information',
    category: 'payoff',
    subject: 'Your payoff figure',
    body_html: `<p>Hi {{first_name}},</p>
<p>Here is the current estimated payoff for {{property_address}}:</p>
<ul>
  <li><b>Principal balance:</b> {{balance}}</li>
  <li><b>Estimated payoff:</b> {{payoff_amount}}</li>
  <li><b>Interest rate:</b> {{interest_rate}}</li>
</ul>
<p>This is an estimate. Message us when you're ready and we'll prepare an official payoff letter with a good-through date.</p>
<p>— {{company_name}}</p>`,
  },
];

function seedTemplates(companyId) {
  const existing = get('SELECT COUNT(*) c FROM message_templates WHERE company_id=?', companyId).c;
  if (existing) return 0;
  for (const t of STARTERS) {
    run(`INSERT INTO message_templates (company_id, name, category, subject, body_html, is_starter)
         VALUES (?,?,?,?,?,1)`, companyId, t.name, t.category, t.subject, t.body_html);
  }
  return STARTERS.length;
}

module.exports = {
  MERGE_FIELDS, buildMergeValues, applyMerge, sanitizeHtml, brandedShell, contactBlock,
  htmlToText, seedTemplates, escapeHtml, STARTERS,
};
