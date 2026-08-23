// Certified mail through Lob, with no SDK — one POST to create a letter, one GET to
// see what the postal service has done with it. Same philosophy as sms.js: the API is
// two endpoints, a dependency would be forty.
//
// Why this exists: some notices have to be provable. A 30-day default notice sent
// certified produces a USPS tracking number and delivery scans — the kind of evidence
// a forfeiture case actually needs. Lob prints the letter, stuffs the envelope, and
// mails it; we keep the tracking number on the notice it belongs to.
//
// Test keys start "test_", live keys "live_". Test letters render and track like real
// ones but nothing is printed or mailed and nothing is charged — which is exactly how
// to prove the wiring before spending money on stamps.

const API = 'https://api.lob.com/v1';

function authHeader(key) {
  return 'Basic ' + Buffer.from(String(key) + ':').toString('base64');
}

async function lobFetch(key, path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { Authorization: authHeader(key) };
  if (body) headers['Content-Type'] = 'application/json';
  // Lob honours Idempotency-Key on creates: a retried request returns the original
  // letter instead of printing and billing a second one.
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 100);

  let r, text;
  try {
    r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    text = await r.text();
  } catch (e) {
    throw new Error(`Could not reach Lob: ${e.message}`);
  }
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) {
    const msg = (json && json.error && json.error.message) || text.slice(0, 200) || `HTTP ${r.status}`;
    if (r.status === 401) throw new Error('Lob rejected the API key. Check it was copied whole.');
    if (r.status === 422) throw new Error(`Lob rejected the letter: ${msg}`);
    if (r.status === 429) throw new Error('Lob is rate limiting — try again in a moment.');
    throw new Error(`Lob error: ${msg}`);
  }
  return json;
}

// A letter needs a real return address. The key alone is not enough to be "enabled" —
// mail without a deliverable from-address bounces at the print shop.
function creds(company) {
  const co = company || {};
  const key = co.lob_api_key || process.env.LOB_API_KEY;
  if (!key) return null;
  const from = {
    name: co.mgmt_company_name || co.name || 'Servicer',
    address_line1: co.mail_address_line1 || process.env.LOB_FROM_LINE1,
    address_city: co.mail_address_city || process.env.LOB_FROM_CITY,
    address_state: co.mail_address_state || process.env.LOB_FROM_STATE,
    address_zip: co.mail_address_zip || process.env.LOB_FROM_ZIP,
  };
  if (!from.address_line1 || !from.address_city || !from.address_state || !from.address_zip) return null;
  return { key, from, test: /^test_/.test(key), costCents: Number(co.lob_cost_cents) || 0 };
}

const lobEnabled = (company) => !!creds(company);

// Wrap plain notice text in the minimal HTML Lob's letter renderer wants. The top
// margin leaves room for the address block Lob prints on page one.
function letterHtml({ subject, body }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paras = String(body).split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  return `<html><head><style>
    body { font-family: Georgia, serif; font-size: 12px; color: #111; }
    .page { margin: 0.75in; margin-top: 2.6in; }
    h1 { font-size: 15px; margin-bottom: 14px; }
    p { margin: 0 0 10px; line-height: 1.5; }
  </style></head><body><div class="page">
    <h1>${esc(subject)}</h1>
    ${paras}
  </div></body></html>`;
}

// Create the certified letter. use_type "operational" because this is account
// servicing, not marketing — Lob requires the distinction and the postal rules differ.
async function sendCertifiedLetter(company, { to, subject, body, description, idempotencyKey }) {
  const c = creds(company);
  if (!c) throw new Error('Certified mail is not set up — add the Lob key and your mailing address in Settings.');
  if (!to || !to.address_line1 || !to.address_city || !to.address_state || !to.address_zip) {
    throw new Error('The recipient needs a full mailing address.');
  }
  const letter = await lobFetch(c.key, '/letters', {
    method: 'POST', idempotencyKey,
    body: {
      description: (description || 'Notice').slice(0, 255),
      to: { name: (to.name || 'Occupant').slice(0, 40), address_line1: to.address_line1,
            address_line2: to.address_line2 || undefined, address_city: to.address_city,
            address_state: to.address_state, address_zip: to.address_zip },
      from: c.from,
      file: letterHtml({ subject, body }),
      color: false,
      address_placement: 'top_first_page',
      extra_service: 'certified',
      mail_type: 'usps_first_class',
      use_type: 'operational',
    },
  });
  return {
    id: letter.id,
    tracking_number: letter.tracking_number || null,
    expected_delivery_date: letter.expected_delivery_date || null,
    pdf_url: letter.url || null,
    test: c.test,
    cost_cents: c.costCents,
  };
}

// Where the letter is now. Lob's tracking_events are USPS scans; the last one is the
// current truth. "Delivered" here is the scan a court will accept.
async function getLetterStatus(company, lobId) {
  const c = creds(company);
  if (!c) throw new Error('Lob is not configured');
  const letter = await lobFetch(c.key, `/letters/${lobId}`);
  const events = (letter.tracking_events || []).map(e => ({
    name: e.name, time: e.time || e.date_created,
  }));
  const last = events[events.length - 1];
  return {
    id: letter.id,
    tracking_number: letter.tracking_number || null,
    expected_delivery_date: letter.expected_delivery_date || null,
    status: last ? last.name : 'created',
    events,
  };
}

// Cheapest call that proves the key works.
async function verifyKey(key) {
  if (!key) throw new Error('An API key is needed');
  await lobFetch(key, '/addresses?limit=1');
  return { test: /^test_/.test(key) };
}

module.exports = { lobEnabled, creds, sendCertifiedLetter, getLetterStatus, verifyKey, letterHtml };
