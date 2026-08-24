// The welcome guide — "Your First Home: What Comes Next" — generated per buyer the
// day they first sign into the app, on SAA blue and gold, from the company's own
// homebuyer guide.
//
// One engine, many guides: the city block (utilities, municipal codes, tax billing
// dates) comes from the property's city — Flint, Detroit, or Saginaw, each with its
// own ordinances and phone numbers — and the payment/insurance sections come from how
// the loan is structured. A PITI loan escrows taxes AND insurance; a PIT loan escrows
// taxes only, and the guide tells the buyer plainly that insurance is theirs to pay
// directly. Nothing in here says "mortgage"; these are loans.
//
// Detroit's tax calendar genuinely differs from the rest of the state (summer due
// August 31, winter due January 15) — the kind of detail that makes a generic guide
// worse than none.

const pdfDoc = require('./pdf');

// SAA colours, as PDF rg triplets.
const NAVY = '0.08 0.18 0.42';
const GOLD = '0.72 0.55 0.13';
const INK = '0.13 0.13 0.15';
const GRAY = '0.42 0.44 0.48';

const CITIES = {
  flint: {
    label: 'Flint',
    cityName: 'City of Flint',
    site: 'cityofflint.com',
    codePhone: '(810) 766-7346',
    codeDept: 'City Hall',
    water: ['WATER & SEWER', 'Flint City Treasurer — 1101 S. Saginaw St., Flint, MI 48502 — (810) 766-7015'],
    energy: ['GAS & ELECTRIC', 'DTE Energy — (800) 477-4747  ·  Consumers Energy — (800) 477-5050'],
    trash: 'Trash pickup: call the Flint Department of Public Works to confirm your pickup day and get recycling bins.',
    taxes: {
      summer: 'Billed around July 1. Due by September 14 without penalty. Typically the larger of the two annual bills.',
      winter: 'Billed around December 1. Due by February 14 without penalty.',
    },
    codes: [
      ['Lawn & weeds — Sec. 39-43',
       'Grass, weeds, and other vegetation must be kept below 8 inches at all times. Overgrowth is a declared ' +
       'nuisance; if you do not correct a violation, the city will mow and bill you, and the cost can become a lien. ' +
       'This includes the strip of grass between your sidewalk and the street — it is your responsibility even ' +
       'though it is city right-of-way.'],
      ['Sidewalks — Ch. 42, Art. 5',
       'Keep the sidewalk abutting your property safe and passable, with a minimum 4-foot clear path. The city ' +
       'offers a 50/50 Sidewalk Replacement Program through the Street Maintenance Division. Do not repair public ' +
       'sidewalks without a permit from the Building and Safety Inspections Department.'],
      ['Snow & ice — city ordinance',
       'Clear snow and ice from your sidewalk after each snowfall. Michigan owners can be held liable for injuries ' +
       'on their sidewalk if they created or worsened a hazard.'],
      ['Debris & junk — Ch. 39 nuisance',
       'Junk, abandoned or inoperable vehicles, appliances, scrap, and household items stored in the yard are ' +
       'nuisance violations. The city can order removal and charge you.'],
      ['Permits — building code',
       'Significant repairs, renovations, fences, decks, garages, electrical and plumbing work may require a ' +
       'permit from the Building and Safety Inspections Department. Unpermitted work causes problems at sale and ' +
       'with insurance claims — when in doubt, call before you start.'],
      ['Noise — Sec. 31-70',
       'Excessive noise crossing residential property lines is prohibited. Lawn equipment and outdoor work are ' +
       'fine during normal daytime hours. Violations carry fines of up to $1,500.'],
    ],
  },
  detroit: {
    label: 'Detroit',
    cityName: 'City of Detroit',
    site: 'detroitmi.gov',
    codePhone: '(313) 224-2733',
    codeDept: 'BSEED — Buildings, Safety Engineering and Environmental Department',
    water: ['WATER & SEWER', 'Detroit Water and Sewerage Department (DWSD) — 735 Randolph St. — (313) 267-8000'],
    energy: ['GAS & ELECTRIC', 'DTE Energy (gas and electric) — (800) 477-4747'],
    trash: 'Trash pickup: Priority Waste serves the east side and southwest — (855) 927-8365; WM serves the west ' +
      'side — (844) 233-8764. Look up your pickup day at detroitmi.gov or report issues through the Improve Detroit app.',
    taxes: {
      summer: 'Billed early July. Due in full by August 31 — or in halves, August 15 and January 15. Detroit\'s ' +
        'dates differ from most Michigan cities.',
      winter: 'Billed early December. Due by January 15 — earlier than the February date used elsewhere in Michigan.',
    },
    codes: [
      ['Lawn & weeds — Sec. 8-15-104',
       'Grass and weeds must be kept under 8 inches; noxious weeds are prohibited. Violations carry an $80 blight ' +
       'fine plus costs, and city abatement can be billed back to you.'],
      ['Snow & ice — Sec. 8-15-103',
       'Snow and ice must be removed or salted within 24 hours of forming, and may not be plowed into the roadway.'],
      ['Debris, junk & vehicles — Secs. 8-15-110, 42-2-97',
       'Inoperative or unlicensed vehicles on the property are unlawful ($130 fine). Owners must keep the premises, ' +
       'sidewalks, and adjoining public area free of solid waste. Trash containers go out after 6 p.m. the night ' +
       'before pickup and come in by 9 p.m. collection day (Sec. 42-2-50).'],
      ['Permits — 2019 Detroit City Code Ch. 8',
       'Building, electrical, and plumbing work is permitted through BSEED under the Michigan Construction Code. ' +
       'Call BSEED before starting significant work.'],
      ['Noise — Ch. 16, Art. I',
       'Quiet hours run 10 p.m. to 7 a.m. Excessive noise crossing property lines is a violation.'],
    ],
  },
  saginaw: {
    label: 'Saginaw',
    cityName: 'City of Saginaw',
    site: 'saginaw-mi.com',
    codePhone: '(989) 759-1540',
    codeDept: 'Inspections Division, City Hall',
    water: ['WATER & SEWER', 'City of Saginaw Water Billing — City Hall Room 105, 1315 S. Washington Ave. — (989) 759-1450'],
    energy: ['GAS & ELECTRIC', 'Consumers Energy (gas and electric) — (800) 477-5050'],
    trash: 'Trash pickup: curbside collection is through the Mid Michigan Waste Authority — (989) 781-9555 for ' +
      'your route and missed pickups.',
    taxes: {
      summer: 'Billed July 1. Due by July 31 — penalty and interest begin August 1. Typically the larger bill.',
      winter: 'Billed December 1. Due by February 14 without penalty.',
    },
    codes: [
      ['Lawn & weeds — Sec. 95.02',
       'Grass and weeds must be kept under 9 inches. Overgrowth is a nuisance the city can abate and bill to you.'],
      ['Sidewalks & snow',
       'Keep the sidewalk abutting your property in repair and safe, and never deposit snow or ice into the street. ' +
       'Clear your walk after snowfall — owners can be liable for hazards they create or worsen.'],
      ['Junk & vehicles — Chs. 98 and 151',
       'Junk motor vehicles are prohibited (Ch. 98), and the Property Maintenance Regulations (Ch. 151) are ' +
       'enforced by the Chief Inspector as civil infractions.'],
      ['Permits — Ch. 150 building code',
       'Building work is permitted through the Inspections Division under the Michigan Construction Code — ' +
       '(989) 759-1540 before you start.'],
      ['Noise — Secs. 94.20–94.22',
       'Excessive noise is prohibited; construction work is limited to 7 a.m.–6 p.m. on weekdays without a permit.'],
    ],
  },
};

function cityFor(property) {
  const c = String((property && property.city) || '').trim().toLowerCase();
  return CITIES[c] || null;
}

const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- the document ----------
function render({ company, loan, property, tenant, logo }) {
  const city = cityFor(property);
  const piti = (loan.escrow_structure || 'piti') !== 'pit';
  const servicer = (company && (company.mgmt_company_name || company.name)) || 'SAA Property Management, LLC';
  const trust = (property && property.trust_name) || servicer;
  const lossAddr = [company && company.mailing_address, company && company.mailing_city,
    company && company.mailing_state, company && company.mailing_zip].filter(Boolean);
  const grace = Number(loan.grace_days) || 0;
  const dueDay = Number(loan.due_day) || 1;
  const ord = (n) => n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10 > 3 || (n % 100 >= 11 && n % 100 <= 13) ? 0 : n % 10] || 'th');
  const structureName = piti ? 'PITI' : 'PIT';

  const d = new pdfDoc.Doc({
    title: 'Welcome to Homeownership',
    footer: `${servicer} · This guide is for general information only — it is not legal, tax, or insurance advice.`,
  });

  const H = (s) => { d.space(10); d.text(s, { size: 14, bold: true, color: NAVY, gap: 3 }); d.rule(GOLD); };
  const sub = (s) => d.text(s, { size: 10.5, bold: true, color: GOLD, gap: 3 });
  const p = (s, opts = {}) => d.text(s, { size: 10, color: INK, gap: 4, ...opts });
  const note = (s) => d.text(s, { size: 9, color: GRAY, gap: 4 });
  const check = (s) => { d.text('•  ' + s, { size: 10, color: INK, gap: 5 }); };
  const step = (n, s) => { d.text(`${n}.  ${s}`, { size: 10, color: INK, gap: 5 }); };

  d.letterhead(company, { logo });
  d.space(8);
  d.text('WELCOME TO HOMEOWNERSHIP', { size: 20, bold: true, color: NAVY, gap: 4 });
  d.text('Your First Home: What Comes Next', { size: 12, color: GOLD, gap: 3 });
  d.text(`A practical guide for first-time homeowners in the ${city ? city.label : 'mid-Michigan'} area`,
    { size: 10, color: GRAY, gap: 3 });
  if (property) note(`${property.address}, ${property.city}, MI ${property.zip} · your loan is structured as ${structureName}`);

  // ---- 72 hours ----
  H('COMPLETE WITHIN 72 HOURS OF CLOSING');
  if (piti) {
    check(`Confirm your homeowners insurance. Your loan is structured as PITI — your insurance premium is ` +
      `included in your monthly loan payment and paid from your escrow account by ${servicer}. You are still ` +
      `responsible for placing full replacement cost coverage with your agent and keeping the policy active, ` +
      `with the loss payee below on your declarations page.`);
  } else {
    check(`Obtain full replacement cost homeowners insurance on your property. Your loan is structured as PIT — ` +
      `insurance is NOT included in your monthly loan payment. You pay your insurance premiums directly to your ` +
      `agent, and a lapse in coverage violates your loan agreement.`);
  }
  d.space(3);
  sub('LOSS PAYEE — ADD EXACTLY AS WRITTEN');
  p(trust, { bold: true });
  for (const line of lossAddr.length ? [lossAddr.slice(0, 1).join(''), lossAddr.slice(1).join(', ')] : []) if (line) p(line);
  d.space(4);
  check('Transfer all utility accounts into your name — gas, electric, water, and any others currently in the seller\'s name.');
  check(`Sign into the ${servicer} mobile app and confirm your first payment due date and amount. All payments are made in the app.`);
  check('Update your mailing address with the post office, your employer, and your bank.');
  check('Change the locks. You do not know who has a copy of the previous owner\'s key.');
  check('Locate your water shut-off valve, electrical panel, and gas shut-off before you ever need them in an emergency.');

  // ---- utilities ----
  H('SET UP YOUR UTILITIES');
  p('Make sure all accounts are transferred into your name right away. Ask the seller to call for a final meter ' +
    'reading and specify no shut-off so service continues without interruption.');
  d.space(3);
  if (city) {
    sub(city.energy[0]); p(city.energy[1]); d.space(2);
    sub(city.water[0]); p(city.water[1]); d.space(2);
  }
  sub('CABLE & INTERNET'); p('Spectrum — (866) 625-1890  ·  Xfinity — (800) 934-6489  ·  Comcast — (855) 356-2598'); d.space(2);
  sub('PHONE'); p('AT&T — (888) 333-6651  ·  T-Mobile — (800) 866-2453  ·  Verizon — (800) 837-4966'); d.space(3);
  if (city) p(city.trash);

  // ---- municipal codes ----
  if (city) {
    H(`YOUR RESPONSIBILITIES AS A HOMEOWNER — ${city.label.toUpperCase()} MUNICIPAL CODES`);
    p(`As a property owner in the ${city.cityName}, you are legally responsible for maintaining your home and the ` +
      'area immediately around it. Violations can mean fines, city-performed work billed back to you, and in some ' +
      'cases a lien against your property.');
    d.space(3);
    for (const [title, body] of city.codes) {
      sub(title); p(body); d.space(3);
    }
    p(`Report violations to the city, not to us. For code enforcement questions call ${city.codeDept} at ` +
      `${city.codePhone} or visit ${city.site}.`, { bold: true });
  }

  // ---- payments ----
  H('MAKING YOUR LOAN PAYMENTS');
  p('Your loan payment is your most important monthly bill. Here is how to stay on track from day one.');
  d.space(3);
  step(1, `Your loan servicer is ${servicer}. We collect your payments and manage your account.`);
  step(2, `All payments are made through the ${servicer} mobile app — card, bank transfer, or Cash App Pay. ` +
    'Payments are not accepted by mail, in person, or anywhere outside the app.');
  step(3, 'Enroll in autopay. It is the single best habit you can form as a new homeowner — and when you enroll ' +
    'in autopay, your $50.00 servicing fee is removed.');
  step(4, `Your payment is due on the ${ord(dueDay)} of each month` +
    (grace ? `, with a grace period of ${grace} days. After the grace period a late fee of ${money(loan.late_fee_cents || 0)} ` +
      'is charged and late notices begin.' : '. After the due date a late fee may be charged and late notices begin.'));
  step(5, 'If you ever know a payment will be late, message us in the app before the due date. There are options — ' +
    'but only if you reach out first.');
  d.space(4);
  sub(`WHAT YOUR PAYMENT COVERS — ${structureName}`);
  if (piti) {
    p('Principal, interest, property taxes, and homeowners insurance — called PITI. The tax and insurance ' +
      `portions are held in escrow and paid on your behalf by ${servicer}.`);
  } else {
    p('Principal, interest, and property taxes — called PIT. The tax portion is held in escrow and paid on your ' +
      `behalf by ${servicer}. Homeowners insurance is NOT included — you pay your insurance directly to your agent.`);
  }

  // ---- taxes ----
  if (city) {
    H(`HOW PROPERTY TAXES WORK IN ${city.label.toUpperCase()}`);
    p('Your property taxes are collected through your monthly loan payment and held in escrow. ' +
      `${servicer} pays your tax bills directly on your behalf — you do not send a separate check to the city.`);
    d.space(3);
    sub('SUMMER TAX BILL'); p(city.taxes.summer); d.space(2);
    sub('WINTER TAX BILL'); p(city.taxes.winter); d.space(3);
    p('Your escrow account handles this. You may receive a copy of the tax bill in the mail — keep it for your ' +
      'records. The payment is already being taken care of.');
  }

  // ---- insurance ----
  H('YOUR HOMEOWNERS INSURANCE');
  step(1, 'Full replacement cost coverage means your policy must pay to rebuild your home completely if it is ' +
    'destroyed — not just its current market value. Confirm this with your agent.');
  step(2, `Add ${trust} as loss payee${lossAddr.length ? ` at ${lossAddr.join(', ')}` : ''}. This is required — ` +
    'verify it appears correctly on your declarations page.');
  if (piti) {
    step(3, `Your premium is paid from escrow by ${servicer} as part of your monthly loan payment. Keep the ` +
      'policy itself active and in your name.');
  } else {
    step(3, 'You pay your premiums directly. Set a reminder — a missed premium can cancel your coverage.');
  }
  step(4, 'Personal belongings are separate. The policy covers the structure; furniture, electronics, and ' +
    'valuables need personal property coverage. Ask your agent.');
  step(5, 'Create a home inventory: walk through your home and video record your belongings, then store the ' +
    'video in the cloud.');
  step(6, 'Keep your policy active. A lapse violates your loan agreement and can result in force-placed ' +
    'insurance — far more expensive, and it protects only the lender.');

  // ---- contractors ----
  H('FIND CONTRACTORS BEFORE YOU NEED THEM');
  p('Maintenance and repairs are now your responsibility. The best time to find a reliable contractor is before ' +
    'you have an emergency.');
  step(1, `Ask neighbors, friends, and family for recommendations — word of mouth is the best way to find ` +
    `trustworthy local contractors in the ${city ? city.label : 'mid-Michigan'} area.`);
  step(2, 'Build a short list now: a plumber, an electrician, an HVAC technician, and a general handyman. Save ' +
    'their numbers in your phone.');
  step(3, 'Get at least two quotes for any job over $500.');
  step(4, 'Verify that any contractor is licensed and insured in Michigan — check licenses at the Michigan LARA website.');

  // ---- budget ----
  H('SET A HOUSEHOLD BUDGET');
  p('Owning a home costs more than your loan payment alone. Plan for all of these:');
  d.space(2);
  sub('MONTHLY FIXED'); p(`Loan payment (${structureName}), internet, trash${piti ? '' : ', homeowners insurance'}`);
  sub('MONTHLY VARIABLE'); p('Gas, electric, water, phone, groceries, transportation');
  sub('SEASONAL COSTS'); p('Lawn care, snow removal, higher winter heating bills');
  sub('MAINTENANCE FUND'); p('Set aside 1% of your home\'s value per year for repairs and upkeep');
  d.space(3);
  p('Start an emergency fund. Aim for at least $1,000 as quickly as possible. Water heaters fail, pipes burst, ' +
    'and furnaces stop working — usually when you least expect it.', { bold: true });

  // ---- credit ----
  H('BUILD AND PROTECT YOUR CREDIT');
  step(1, 'Pay your loan on time every single month. On-time payment history is the most impactful thing you can ' +
    'do for your financial standing.');
  step(2, 'Check your credit report for free at AnnualCreditReport.com once a year and dispute any errors.');
  step(3, 'Keep credit card balances below 30% of the card limit — high utilization hurts your score even when ' +
    'you pay on time.');
  step(4, 'Avoid opening several new accounts at once; each hard inquiry temporarily lowers your score.');
  step(5, 'A strong payment history puts you in a better position to refinance your loan at a lower rate when ' +
    'the time comes.');

  d.space(12);
  d.text('Congratulations on your new home.', { size: 13, bold: true, color: NAVY, gap: 4 });
  p(`We are proud to have been part of your journey. — ${servicer}`);
  note('This guide is for general informational purposes only. Please consult your servicer, tax advisor, or ' +
    'insurance agent for advice specific to your situation.');

  return d.build();
}

module.exports = { render, cityFor, CITIES };
