const { inheritsEnv } = require('./db');
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

// When a real PDF has to travel — a court form, not our own HTML — Lob wants
// multipart/form-data. Built by hand: a boundary, one part per field, the file part
// with a content type. Nested objects (to[name] etc.) flatten to bracket keys.
function multipartBody(fields, fileBuf, fileField) {
  const boundary = '----porchpay' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const parts = [];
  const flat = (prefix, val) => {
    if (val === undefined || val === null) return;
    if (typeof val === 'object' && !Buffer.isBuffer(val)) {
      for (const [k, v] of Object.entries(val)) flat(`${prefix}[${k}]`, v);
    } else {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${prefix}"\r\n\r\n${val}\r\n`));
    }
  };
  for (const [k, v] of Object.entries(fields)) flat(k, v);
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="letter.pdf"\r\nContent-Type: application/pdf\r\n\r\n`));
  parts.push(fileBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function lobFetch(key, path, { method = 'GET', body, idempotencyKey, pdf } = {}) {
  const headers = { Authorization: authHeader(key) };
  // Lob honours Idempotency-Key on creates: a retried request returns the original
  // letter instead of printing and billing a second one.
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 100);

  let payload;
  if (pdf) {
    const mp = multipartBody(body || {}, pdf, 'file');
    headers['Content-Type'] = mp.contentType;
    payload = mp.body;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  // A timeout, because this is called from inside the nightly notice sweep, which walks
  // every loan in the portfolio one at a time. Without one, a single hung request to
  // Lob stops the sweep dead and every account behind it silently goes unnoticed for
  // the night. Twenty seconds is generous for an API that normally answers in under one.
  let r, text;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    r = await fetch(API + path, { method, headers, body: payload, signal: ac.signal });
    text = await r.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Lob did not answer within 20 seconds');
    throw new Error(`Could not reach Lob: ${e.message}`);
  } finally {
    clearTimeout(timer);
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
  // A letter carries a return address. Another company's letters must not go out from
  // the host's, and must not be billed to the host's Lob account.
  const envOk = inheritsEnv(company);
  const key = co.lob_api_key || (envOk ? process.env.LOB_API_KEY : null);
  if (!key) return null;
  const from = {
    name: co.mgmt_company_name || co.name || 'Servicer',
    address_line1: co.mail_address_line1 || (envOk ? process.env.LOB_FROM_LINE1 : null),
    address_city: co.mail_address_city || (envOk ? process.env.LOB_FROM_CITY : null),
    address_state: co.mail_address_state || (envOk ? process.env.LOB_FROM_STATE : null),
    address_zip: co.mail_address_zip || (envOk ? process.env.LOB_FROM_ZIP : null),
  };
  if (!from.address_line1 || !from.address_city || !from.address_state || !from.address_zip) return null;
  return { key, from, test: /^test_/.test(key), costCents: Number(co.lob_cost_cents) || 0 };
}

const lobEnabled = (company) => !!creds(company);

// Lob's API does not return the price of a piece, but their published rate card is
// exact, so the cost is computed here at ordering time. Developer-plan rates as of
// the July 2026 USPS adjustment (help.lob.com → pricing details); a settings override
// exists for accounts on negotiated plans.
const RATES = {
  letter_first_class_bw_cents: 106,   // 1-page B/W letter, first class, incl. print+postage+envelope
  certified_addon_cents: 695,         // certified mail surcharge
  err_addon_cents: 986,               // certified WITH electronic return receipt surcharge
  extra_page_cents: 10,               // each additional B/W page
};
// How many pages a notice will actually print to. Lob bills per page and the cost is
// passed on to the buyer as a collection fee, so getting this wrong puts a figure in
// the ledger that the Lob invoice will not agree with.
//
// It used to assume one page for every letter we compose ourselves, which is wrong for
// most of them — the Michigan 5-day notice runs to two pages on its own, and the 30-day
// notice with the reservation of rights is longer still.
//
// This counts against the layout in letterHtml: a 8.5x11 page with 0.75in margins is
// about 88 characters wide at 12px Georgia and holds roughly 62 lines at 1.5 line
// height. Page one loses 2.6in to the address block Lob prints, so about 46 lines. It
// is an estimate and it is allowed to be — one page out on a 10c-per-page charge is
// not worth fetching the rendered PDF back to count. It is far closer than "1".
function estimatePages({ subject = '', body = '' }) {
  const COLS = 88, FIRST_PAGE_LINES = 46, LATER_PAGE_LINES = 62;
  let lines = Math.ceil((String(subject).length || 1) / COLS) + 1;   // heading plus its space
  for (const para of String(body).split('\n')) {
    lines += Math.max(1, Math.ceil(para.length / COLS));
    if (!para.length) continue;
    lines += 0.6;                                                    // paragraph spacing
  }
  if (lines <= FIRST_PAGE_LINES) return 1;
  return 1 + Math.ceil((lines - FIRST_PAGE_LINES) / LATER_PAGE_LINES);
}

function estimateCostCents({ service = 'certified', pages = 1 } = {}) {
  let c = RATES.letter_first_class_bw_cents + Math.max(0, pages - 1) * RATES.extra_page_cents;
  if (service === 'certified') c += RATES.certified_addon_cents;
  if (service === 'certified_return_receipt') c += RATES.err_addon_cents;
  return c;
}

// ---------- is this address real ----------
// A certified letter costs eight dollars and its whole value is the delivery scan.
// Buying one for an address the postal service cannot deliver to spends the money and
// produces the opposite of evidence. Lob will verify an address for free, so ask first.
//
// Deliverability comes back as one of a handful of values. "deliverable" is the happy
// path. "deliverable_unnecessary_unit" and "deliverable_incorrect_unit" still arrive —
// the building is right and the unit line is off — so those go, with a note. Missing a
// required unit, or undeliverable outright, does not go.
const DELIVERABLE = {
  deliverable: null,
  deliverable_unnecessary_unit: 'The unit line is not needed at this address; it was still mailed.',
  deliverable_incorrect_unit: 'The unit number did not match USPS records; it was still mailed.',
};
const UNDELIVERABLE = {
  deliverable_missing_unit: 'USPS needs a unit or apartment number for this address.',
  undeliverable: 'USPS does not recognise this address.',
};

async function verifyAddress(key, to) {
  const res = await lobFetch(key, '/us_verifications', {
    method: 'POST',
    body: {
      primary_line: to.address_line1,
      secondary_line: to.address_line2 || '',
      city: to.address_city,
      state: to.address_state,
      zip_code: to.address_zip,
    },
  });
  const d = res.deliverability;
  if (Object.prototype.hasOwnProperty.call(DELIVERABLE, d)) {
    return { ok: true, deliverability: d, note: DELIVERABLE[d] };
  }
  return {
    ok: false,
    deliverability: d,
    reason: UNDELIVERABLE[d] || `USPS returned "${d}" for this address.`,
  };
}

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

// Create a letter — certified with tracking, or plain first class. use_type
// "operational" because this is account servicing, not marketing — Lob requires the
// distinction and the postal rules differ. The returned cost is the company's
// override when one is set, otherwise the computed published rate.
// Create a letter — certified with tracking, or plain first class. Content is either
// our own HTML (subject + body) or a finished PDF such as a filled court form. A PDF
// goes up as multipart with the address on an inserted page, so page one of the form
// arrives exactly as the court published it — nothing overprinted.
async function sendLetter(company, { to, subject, body, pdf, pdfPages = 1, description, idempotencyKey,
                                     service = 'certified', skipVerify = false }) {
  const c = creds(company);
  if (!c) throw new Error('Mail is not set up — add the Lob key and your mailing address in Settings.');
  if (!to || !to.address_line1 || !to.address_city || !to.address_state || !to.address_zip) {
    throw new Error('The recipient needs a full mailing address.');
  }

  // Check the address before buying the postage. If the check itself cannot run —
  // Lob down, network gone — that is not a reason to refuse to send a legal notice,
  // so a failed verification call is noted and the letter goes anyway. A verification
  // that runs and says undeliverable does stop it.
  let verification = null;
  if (c.test) {
    // A test key does not verify addresses. Lob accepts the call and simulates a
    // response, so asking would come back clean for an address that does not exist —
    // which is worse than not asking, because the notice record would then claim the
    // address was checked. Say plainly that it was not.
    verification = { ok: true, deliverability: 'unchecked',
      note: 'Address not verified — a test key cannot check addresses.' };
  } else if (!skipVerify) {
    try {
      verification = await verifyAddress(c.key, to);
    } catch (e) {
      // Lob down, or the free verification allowance used up. Never a reason to refuse
      // to send a legal notice — record that it went unchecked and mail it.
      verification = { ok: true, deliverability: 'unchecked', note: `Address not verified: ${e.message}` };
    }
    if (!verification.ok) {
      const err = new Error(verification.reason);
      err.undeliverable = true;
      err.deliverability = verification.deliverability;
      throw err;
    }
  }

  const certified = service !== 'first_class';
  const fields = {
    description: (description || 'Notice').slice(0, 255),
    to: { name: (to.name || 'Occupant').slice(0, 40), address_line1: to.address_line1,
          address_line2: to.address_line2 || undefined, address_city: to.address_city,
          address_state: to.address_state, address_zip: to.address_zip },
    from: c.from,
    color: false,
    address_placement: pdf ? 'insert_blank_page' : 'top_first_page',
    ...(certified ? { extra_service: 'certified' } : {}),
    mail_type: 'usps_first_class',
    use_type: 'operational',
  };
  if (!pdf) fields.file = letterHtml({ subject, body });
  const letter = await lobFetch(c.key, '/letters', {
    method: 'POST', idempotencyKey, pdf,
    body: fields,
  });
  // The inserted address page is a page like any other on the bill. For a letter we
  // composed ourselves, count what it will print to rather than assuming one sheet.
  const pages = pdf ? pdfPages + 1 : estimatePages({ subject, body });
  return {
    id: letter.id,
    tracking_number: letter.tracking_number || null,
    expected_delivery_date: letter.expected_delivery_date || null,
    pdf_url: letter.url || null,
    test: c.test,
    service,
    verification_note: verification ? verification.note : null,
    cost_cents: c.costCents > 0 ? c.costCents : estimateCostCents({ service: certified ? 'certified' : 'first_class', pages }),
  };
}
const sendCertifiedLetter = (company, opts) => sendLetter(company, { ...opts, service: 'certified' });

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

// Whether this company's key is a Lob test key. A test letter renders, tracks and
// returns a tracking number exactly like a real one, and is never printed or mailed —
// so anything that treats a letter as service of process has to ask this first.
function isTestKey(company) {
  const c = creds(company);
  return !!c && c.test;
}

module.exports = { lobEnabled, creds, isTestKey, sendLetter, sendCertifiedLetter, getLetterStatus,
  verifyKey, verifyAddress, letterHtml, estimateCostCents, estimatePages, RATES };
