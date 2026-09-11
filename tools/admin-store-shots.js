// Store screenshots for PorchPay Admin, rendered from the real app.
//
// Boots a private copy of the server on its own empty data folder, fills it with a
// fictional servicing company (eight houses, buyers, crew, texts, calls, payments), then
// drives Chrome headless through the staff app at the exact pixel sizes each store
// slot demands. Nothing touches the live site or a real record.
//
//   npm i --no-save puppeteer-core
//   node tools/admin-store-shots.js "<output folder>" [path to chrome.exe]
//
// Sizes are produced natively (viewport x device scale), not resized afterwards:
//   ios-6.9        440x956  @3  -> 1320x2868  (App Store 6.9" iPhone)
//   play-phone     360x640  @3  -> 1080x1920
//   play-tablet7   600x960  @2  -> 1200x1920
//   play-tablet10  800x1280 @2  -> 1600x2560
// plus play-icon-512.png and play-feature-graphic-1024x500.png.
const os = require('os'), fs = require('fs'), path = require('path');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'store-assets', 'admin'));
const CHROME = process.argv[3] || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/opt/pw-browsers/chromium',
].find(p => fs.existsSync(p));

process.env.DATA_DIR = path.join(os.tmpdir(), 'pp-admin-shots-' + Date.now());
process.env.PORT = process.env.PORT || '3456';
process.env.ADMIN_EMAIL = 'owner@demo.porchpay.app';
process.env.ADMIN_PASSWORD = 'ShotsDemo2026!';
// A private run must never reach a real provider, whatever the shell happens to hold.
for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'RESEND_API_KEY',
  'EMAIL_PROVIDER', 'STRIPE_SECRET_KEY', 'LOB_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete process.env[k];
require('../server.js');
const D = require('../db.js');
const BASE = 'http://localhost:' + process.env.PORT;

let cookie = '';
async function api(p, opts = {}) {
  const r = await fetch(BASE + p, { headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...opts });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
const iso = d => d.toISOString().slice(0, 10);
const monthsAgo = n => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); return d; };
const ago = min => `datetime('now','-${min} minutes')`;

// Fictional people on real street names. Street numbers are invented.
const HOUSES = [
  { address: '8800 Crestwood Ln', city: 'Flint', state: 'MI', zip: '48507', buyer: 'Alex Rivera', paid: 30, behind: 0 },
  { address: '412 Maple Ave', city: 'Rockford', state: 'IL', zip: '61103', buyer: 'Jordan Ellis', paid: 14, behind: 2 },
  { address: '1935 Birch St', city: 'Saginaw', state: 'MI', zip: '48602', buyer: 'Taylor Brooks', paid: 22, behind: 0 },
  { address: '77 Lakeview Dr', city: 'Muskegon', state: 'MI', zip: '49441', buyer: 'Casey Morgan', paid: 41, behind: 0 },
  { address: '2210 Elm Ct', city: 'Peoria', state: 'IL', zip: '61604', buyer: 'Riley Chen', paid: 9, behind: 0 },
  { address: '509 Cedar Rd', city: 'Kalamazoo', state: 'MI', zip: '49001', buyer: 'Morgan Patel', paid: 18, behind: 1 },
  { address: '1348 Oak Hollow Dr', city: 'Lansing', state: 'MI', zip: '48910', buyer: 'Sam Whitaker', paid: 27, behind: 0 },
  { address: '60 Pine Ridge Rd', city: 'Bay City', state: 'MI', zip: '48706', buyer: 'Dana Flores', paid: 12, behind: 0 },
];

async function seed() {
  // The server runs its notice sweep five seconds after boot. Let it run on an empty
  // company first; seeded mid-sweep, houses with no payments yet get late fees and
  // notices for months that, in this story, were paid on time.
  await new Promise(r => setTimeout(r, 7000));
  await api('/api/login', { method: 'POST', body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }) });
  await api('/api/change-password', { method: 'POST', body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) });
  await api('/api/admin/company', { method: 'PUT', body: JSON.stringify({
    company_name: 'Great Lakes Home Servicing', mgmt_company_name: 'Great Lakes Home Servicing',
    company_email: 'support@porchpay.app', company_phone: '810-555-0142' }) }).catch(() => {});
  D.run("UPDATE users SET name='Morgan Hale' WHERE email=?", process.env.ADMIN_EMAIL);
  const owner = D.get('SELECT id FROM users WHERE email=?', process.env.ADMIN_EMAIL);

  const METHODS = ['check', 'zelle', 'check', 'zelle', 'cash', 'check'];
  for (const [i, h] of HOUSES.entries()) {
    const prop = await api('/api/admin/properties', { method: 'POST', body: JSON.stringify({
      address: h.address, city: h.city, state: h.state, zip: h.zip, beds: 3, baths: 1 + (i % 2), sqft: 1100 + i * 90 }) });
    const slug = h.buyer.toLowerCase().replace(/\s+/g, '.');
    const buyer = await api('/api/admin/tenants', { method: 'POST', body: JSON.stringify({
      name: h.buyer, email: slug + '@example.com', phone: `810-555-01${String(20 + i).padStart(2, '0')}` }) });
    const principal = 6_200_000 + i * 480_000;
    const { loan } = await api('/api/admin/loans', { method: 'POST', body: JSON.stringify({
      property_id: prop.id, tenant_user_id: buyer.id, loan_type: i % 3 === 1 ? 'agreement_for_deed' : 'land_contract',
      sale_price_cents: principal + 800_000, down_payment_cents: 800_000, principal_cents: principal,
      interest_rate_bps: 950 + (i % 4) * 50, term_months: 240 + (i % 3) * 60, escrow_cents: 18_000 + i * 1500,
      late_fee_cents: 5000, grace_days: 10, first_payment_date: iso(monthsAgo(h.paid)) }) });
    Object.assign(h, { id: prop.id, loan_id: loan.id, buyer_id: buyer.id, due: loan.payment_cents + 18_000 + i * 1500, i });
  }
  // Payments go in month by month across the whole portfolio, the order they really
  // arrive in, so the Money feed (newest first) reads as a portfolio and not one house.
  // Lakeview and Oak Hollow post last: they are today's payments.
  const ORDER = [0, 1, 2, 4, 5, 7, 3, 6].map(i => HOUSES[i]);
  for (let k = Math.max(...HOUSES.map(h => h.paid)); k >= 0; k--) {
    for (const h of ORDER) {
      if (k > h.paid || k < h.behind) continue;
      await api(`/api/admin/loans/${h.loan_id}/payments`, { method: 'POST', body: JSON.stringify({
        amount_cents: h.due, entry_date: iso(monthsAgo(k)), method: METHODS[(k + h.i) % METHODS.length] }) });
    }
  }
  // Posted a second ago, but received on their due dates: the conversation timeline
  // should show them where they happened, not stacked at the bottom as "just now".
  D.run("UPDATE ledger SET created_at = entry_date || ' 17:00:00' WHERE type='payment'");
  // While the history was going in, the notice engine saw houses with no payments yet and
  // did its job: late fees, late notices, non-waiver receipts. Only the two houses that
  // really are behind keep theirs; for the rest that paperwork answers a moment that
  // never happened in this story.
  // Some of it lands a moment later, so this runs again before every device pass.
  const notBehind = `(${HOUSES.filter(h => !h.behind).map(h => h.loan_id).join(',')})`;
  const tidy = () => {
    D.run(`DELETE FROM ledger WHERE type='late_fee' AND loan_id IN ${notBehind}`);
    D.run(`UPDATE loans SET fees_due_cents=0 WHERE id IN ${notBehind}`);
    D.run(`DELETE FROM notices WHERE loan_id IN ${notBehind}`);
    D.run(`DELETE FROM messages WHERE body_html IS NOT NULL AND loan_id IN ${notBehind}`);
    D.run(`DELETE FROM email_log WHERE loan_id IN ${notBehind}`);
    // The houses that are behind keep their notices, filed as days old.
    D.run("UPDATE messages SET created_at=datetime('now','-4 days') WHERE body_html IS NOT NULL AND created_at > datetime('now','-1 day')");
    D.run("UPDATE notices SET created_at=datetime('now','-4 days'), sent_at=datetime('now','-4 days') WHERE created_at > datetime('now','-1 day')");
    D.run("UPDATE email_log SET created_at=datetime('now','-4 days') WHERE created_at > datetime('now','-1 day')");
  };
  tidy();
  // Today's payments, so the Money tab leads with fresh activity.
  for (const [idx, method] of [[3, 'zelle'], [6, 'check']]) {
    const h = HOUSES[idx];
    D.run(`UPDATE ledger SET entry_date=date('now'), method=?, created_at=${ago(40 + idx * 25)}
      WHERE id=(SELECT MAX(id) FROM ledger WHERE loan_id=? AND type='payment')`, method, h.loan_id);
  }

  // The crew, attached to their houses.
  const crew = [
    { name: 'Marcus Reed', role: 'bog', phone: '810-555-0170', houses: [0, 2, 6] },
    { name: 'Dwayne Holt', role: 'contractor', business_name: 'Holt Plumbing', phone: '815-555-0133', houses: [1, 2] },
    { name: 'Lisa Grant', role: 'lender', phone: '231-555-0190', houses: [3] },
    { name: 'Priya Shah', role: 'cobuyer', phone: '810-555-0161', houses: [0] },
    { name: 'Tony Alvarez', role: 'bog', phone: '309-555-0114', houses: [1, 4] },
  ];
  for (const c of crew) {
    const r = await api('/api/admin/contacts', { method: 'POST', body: JSON.stringify(c) });
    c.id = r.id || (r.contact && r.contact.id);
    for (const hi of c.houses) {
      await api(`/api/admin/properties/${HOUSES[hi].id}/contacts`, { method: 'POST', body: JSON.stringify({ contact_id: c.id }) });
    }
  }
  const C = Object.fromEntries(crew.map(c => [c.name.split(' ')[0], c]));
  const co = D.get('SELECT company_id FROM users WHERE id=?', owner.id).company_id;

  const msg = (h, fromBuyer, body, min, channels = 'app', read = 1) => D.run(
    `INSERT INTO messages (loan_id, sender_user_id, body, read_by_admin, read_by_tenant, channels, created_at)
     VALUES (?,?,?,?,1,?,${ago(min)})`, h.loan_id, fromBuyer ? h.buyer_id : owner.id, body, fromBuyer ? read : 1, channels);
  const text = (h, c, dir, body, min, read = 1) => D.run(
    `INSERT INTO contact_messages (company_id, contact_id, property_id, direction, phone, body, status, sent_by, read_at, created_at)
     VALUES (?,?,?,?,?,?,'sent',?,${dir === 'in' && !read ? 'NULL' : ago(min)},${ago(min)})`,
    co, c.id, h.id, dir, c.phone, body, dir === 'out' ? owner.id : null);
  const call = (h, dir, who, phone, status, secs, min, contactId = null) => D.run(
    `INSERT INTO call_log (company_id, direction, mode, call_sid, counterpart_phone, counterpart_name, user_id,
       loan_id, contact_id, property_id, duration_sec, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,${ago(min)})`, co, dir, dir === 'in' ? 'inbound' : 'cell',
    'CA' + Math.random().toString(16).slice(2, 12), phone, who, owner.id, h.loan_id, contactId, h.id, secs, status);

  const [crest, maple, birch, lake, elm, cedar, oak, pine] = HOUSES;
  // 412 Maple: behind, and talking about it.
  msg(maple, false, 'Hi Jordan, this is a friendly reminder that your September payment is past due. You can pay in the app any time, or reply here if you need to talk through a plan.', 60 * 26, 'app,sms');
  call(maple, 'in', 'Jordan Ellis', '+18105550121', 'completed', 214, 60 * 5);
  msg(maple, true, 'Thanks for talking with me earlier. I get paid Friday. Can I send $400 today and the rest Friday?', 38, 'sms', 0);
  text(maple, C.Tony, 'in', 'Drove by 412 Maple this morning. Porch light out, yard looks good. Buyer\'s car in the drive.', 95, 0);
  // 1935 Birch: the crew is working.
  text(birch, C.Dwayne, 'out', '1935 Birch St: buyer reports water under the kitchen sink. Can you get eyes on it today?', 60 * 20);
  text(birch, C.Dwayne, 'in', 'On site now. Supply line cracked. Replacing it, about 45 min, $185 parts and labor.', 60 * 3);
  text(birch, C.Marcus, 'in', 'Lockbox code changed to the new one. Furnace filter done, photos uploaded.', 22, 0);
  text(birch, C.Dwayne, 'in', 'All done at Birch. No more leak, cabinet floor drying out.', 12, 0);
  msg(birch, true, 'The plumber just left, sink is fixed. Thank you so much for sending someone so fast!', 9, 'app', 0);
  // 8800 Crestwood: co-buyer and a missed call.
  call(crest, 'in', 'Alex Rivera', '+18105550120', 'missed', 0, 70);
  msg(crest, true, 'Can you send me my payoff amount? We might refinance with the credit union next spring.', 64, 'app', 0);
  text(crest, C.Priya, 'in', 'Hi, it\'s Priya, Alex\'s co-buyer. Is the insurance renewal in escrow this year?', 60 * 7, 1);
  // Quieter houses still have a history.
  msg(lake, false, 'Payment received, thank you Casey. Your receipt is in the app.', 55);
  call(lake, 'out', 'Lisa Grant', '+12315550190', 'completed', 342, 60 * 30, C.Lisa.id);
  msg(elm, true, 'Is it OK if I paint the back bedroom?', 60 * 50);
  msg(elm, false, 'Of course. It is your home. Just keep receipts for anything structural.', 60 * 49);
  text(elm, C.Tony, 'in', 'Gutters cleaned at 2210 Elm. Photos in the folder.', 60 * 72);
  msg(cedar, false, 'Hi Morgan, your August payment came in short by $212. Reply here and we can sort it out.', 60 * 30, 'app,sms');
  call(oak, 'out', 'Sam Whitaker', '+18105550126', 'completed', 96, 60 * 28);
  text(oak, C.Marcus, 'in', 'Annual walkthrough at 1348 Oak Hollow done. Smoke detectors tested, all good.', 60 * 45);
  msg(pine, true, 'Autopay is set up, thanks for walking me through it.', 60 * 96);
  // The engine files a real Notice of Default for the house that is behind the moment
  // the server boots. Keep it, but as history: days old, not the newest thing on screen.
  D.run("UPDATE messages SET created_at=datetime('now','-4 days') WHERE body_html IS NOT NULL");
  D.run("UPDATE notices SET created_at=datetime('now','-4 days'), sent_at=datetime('now','-4 days')");
  D.run("UPDATE email_log SET created_at=datetime('now','-4 days')");
  D.run("UPDATE notifications SET read_at=datetime('now') WHERE read_at IS NULL");
  console.log('seeded', HOUSES.length, 'houses');
  const unread = snapshotUnread();
  return { houses: HOUSES, reset: () => { tidy(); unread(); } };
}

// Opening a thread marks it read. Each device pass must start from the same state.
function snapshotUnread() {
  const m = D.all('SELECT id FROM messages WHERE read_by_admin=0').map(r => r.id);
  const t = D.all('SELECT id FROM contact_messages WHERE read_at IS NULL').map(r => r.id);
  return () => {
    for (const id of m) D.run('UPDATE messages SET read_by_admin=0 WHERE id=?', id);
    for (const id of t) D.run('UPDATE contact_messages SET read_at=NULL WHERE id=?', id);
    // Everything seen as of now, so the red dots are exactly the unread items above.
    D.run('DELETE FROM comms_seen');
    for (const p of [{ id: 0 }, ...D.all('SELECT id FROM properties')]) {
      D.run(`INSERT INTO comms_seen (user_id, property_id, last_seen_at)
        SELECT id, ?, strftime('%Y-%m-%d %H:%M:%f','now') FROM users WHERE email=?`, p.id, process.env.ADMIN_EMAIL);
    }
  };
}

const DEVICES = [
  { dir: 'ios-6.9', w: 440, h: 956, s: 3 },
  { dir: 'play-phone', w: 360, h: 640, s: 3 },
  { dir: 'play-tablet7', w: 600, h: 960, s: 2 },
  { dir: 'play-tablet10', w: 800, h: 1280, s: 2 },
];
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

async function shoot({ houses, reset }) {
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    userDataDir: path.join(os.tmpdir(), 'pp-shots-profile-' + Date.now()),
    args: ['--hide-scrollbars', '--no-first-run', '--no-default-browser-check'] });
  const [crest, maple, birch] = houses;
  await new Promise(r => setTimeout(r, 3000));
  for (const d of DEVICES) {
    reset();
    const dir = path.join(OUT, d.dir); fs.mkdirSync(dir, { recursive: true });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    // Late afternoon on the clock, whenever this runs: timestamps read like a workday.
    await page.emulateTimezone('Pacific/Pago_Pago');
    await page.setViewport({ width: d.w, height: d.h, deviceScaleFactor: d.s, isMobile: true, hasTouch: true });
    await page.goto(BASE + '/staff', { waitUntil: 'networkidle0' });
    await page.evaluate(async (e, p) => {
      await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: p }) });
    }, process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
    await page.goto(BASE + '/staff', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => typeof OV !== 'undefined' && OV && document.querySelector('.sq'));
    const snap = async (name, fn, settle = 900, top = true) => {
      if (fn) await page.evaluate(fn);
      await new Promise(r => setTimeout(r, settle));
      if (top) await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise(r => setTimeout(r, 150));
      await page.screenshot({ path: path.join(dir, name + '.png') });
    };
    // Story order: the portfolio, the inbox, one house, its conversation, the crew, the money.
    await snap('01-homes');
    await snap('02-comms', "go('comms'); loadThreadList()", 1400);
    await snap('03-house', `openProp(${maple.id})`, 1400);
    // A conversation opens on its latest message, as it does on a phone.
    await snap('04-conversation', `openThread(${birch.id},{mode:'sms',from:'comms'})`, 1800, false);
    await page.evaluate(() => { const b = document.querySelector('.sheet:not(.hidden)'); if (b) closeSheet(); });
    // Opening that conversation read it. Put the red dots back for the last two shots.
    reset();
    await page.evaluate(() => refresh());
    await snap('05-crew', "go('bog')", 900);
    await snap('06-money', "go('money')", 900);
    await page.close();
    console.log('shot', d.dir);
  }

  // Play icon: the same icon the build uses, at Play's 512.
  const src = path.join(__dirname, '..', 'mobile', 'assets', 'icon-porchpay-admin.png');
  const iconData = 'data:image/png;base64,' + fs.readFileSync(src).toString('base64');
  const page = await browser.newPage();
  await page.setViewport({ width: 512, height: 512, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0"><img src="${iconData}" width="512" height="512" style="display:block"></body></html>`);
  await page.screenshot({ path: path.join(OUT, 'play-icon-512.png') });

  // Feature graphic: brand ink, the mark, one line, and the Homes screen on a phone.
  const shot = 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, 'ios-6.9', '01-homes.png')).toString('base64');
  const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '..', 'public', 'logo-full-white.png')).toString('base64');
  await page.setViewport({ width: 1024, height: 500, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;width:1024px;height:500px;overflow:hidden;
      background:linear-gradient(135deg,#16220D 0%,#22361A 100%);font-family:'Segoe UI',Roboto,Arial,sans-serif;position:relative">
    <div style="position:absolute;left:64px;top:92px;width:520px;color:#fff">
      <img src="${logo}" style="height:56px;display:block;margin-bottom:34px">
      <div style="font-size:44px;font-weight:700;line-height:1.12;letter-spacing:-.5px">Every house, every<br>conversation, every payment.</div>
      <div style="font-size:21px;color:#B9D7A6;margin-top:18px">The servicer's side of Porch Pay.</div>
    </div>
    <div style="position:absolute;right:86px;top:46px;width:246px;height:534px;border-radius:38px;background:#0B1206;
      padding:9px;box-shadow:0 24px 60px rgba(0,0,0,.45)">
      <img src="${shot}" style="width:100%;height:100%;object-fit:cover;object-position:top;border-radius:30px;display:block">
    </div></body></html>`, { waitUntil: 'load' });
  await page.screenshot({ path: path.join(OUT, 'play-feature-graphic-1024x500.png') });
  await browser.close();
}

(async () => {
  try {
    const s = await seed();
    await shoot(s);
    console.log('done ->', OUT);
    process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
})();
