# PorchPay

A loan servicing platform for seller-financed real estate — land contracts, contracts for
deed, and beneficial interest assignments in land trusts.

Two apps run off one server:

- **PorchPay** at `/` — the mobile app your tenant buyers use. Installs to a phone home
  screen from the browser, or wraps for the App Store and Play Store.
- **PorchPay Admin** at `/admin` — your desktop and mobile servicing portal.

Built multi-company from the ground up: each servicing company gets fully isolated
properties, loans, buyers, and documents, so you can onboard other investors later
without migrating anything.

---

## Running it

Node 22 or newer (the app uses Node's built-in SQLite — nothing to compile).

```bash
npm install
npm start
```

First boot prints a seeded owner login. Open `http://localhost:3000/admin` to sign in;
the buyer app is at `http://localhost:3000/`. You're forced to change the password on
first sign-in.

`npm test` runs the 120-check end-to-end suite: loan math, payment allocation, notices and
read receipts, document permissions, PML tracking, consent gating, location opt-in, archive
and delete flows, owner/staff roles, and 18 cross-company isolation checks.

Deployment instructions are in **DEPLOY.md**. App store requirements are in
**APP-STORE-CHECKLIST.md**. Configuration is documented in **.env.example**.

---

## The admin portal

**New Deal** is the fastest way in. Upload the closing documents — land contract, trust
agreement, settlement statement, as PDFs or phone photos — and Claude reads them and
prefills the buyer's name, email, phone, property address, trust and trustee, sale price,
down payment, amount financed, rate, term, payment, escrow, late fee, and first payment
date. Review every field, fix anything the extraction got wrong, then create the deal.
That one action creates the property, creates the buyer's login with a temporary password
you hand them, and opens the loan with its ledger and amortization schedule.

**The loan page** is where servicing happens: record payments taken outside the app,
assess late fees, add one-time or recurring monthly charges categorized as taxes,
insurance, utilities, servicing fee, HOA or other, message the buyer, and read a ledger
showing how every dollar split across fees, interest, escrow, and principal.

**Document Center** gives each loan five shared folders — Loan Documents, Insurance,
Taxes, Utilities, Correspondence — plus a private admin-only vault. Every folder always
shows, empty or not, so there's an obvious place to drop the new policy or tax bill.
Uploads take a title and effective date so successive years stack newest-first. Anything
filed as private stays admin-only even if the visibility box was checked — the server
enforces that, not just the interface. Move a document into the vault later and the
buyer's access is revoked immediately.

**PML Loans** tracks the private money you owe against the same properties, entirely
invisible to buyers. Each lender loan carries its own terms — amortized, interest-only,
or balloon — its own ledger, draws, and payoff. The list shows your monthly spread
(buyer payment minus lender payment); the detail view adds the balance spread between
what the buyer owes you and what you owe the lender.

**Expenses** takes a bank or credit card statement as PDF or CSV, extracts every expense
line, and puts them in a review queue where you assign each to a property or ignore it.

**Settings** holds your company details and your team. Owners invite additional admins —
a bookkeeper or assistant — who get full access to loans and buyers but can't manage the
team or company details.

**Archiving and deleting.** Tenant buyers and staff can be archived or deleted. Archiving
is the everyday tool: it hides the person from your active list and blocks them from
signing in, while keeping their loan, ledger, documents and messages completely intact —
right for a paid-off buyer or a staffer who left. It's reversible with one click, and the
Tenant Buyers page has an Archived tab. Deleting is permanent: it erases name, email,
phone, login, consent records and location history. The loan's payment ledger survives in
de-identified form, because lending records carry legal retention duties. Delete asks you
to type DELETE and points you at archiving if you might want them back.

---

## What buyers see

PorchPay opens on the balance, a progress bar showing how much principal they've paid off,
and one clear line telling them whether they're caught up or what's due now. Five big tabs:
Home, Pay, Loan, Docs, Messages. Everything is one tap from the home screen.

**Pay** takes a regular amount plus an optional extra-principal amount, then three obvious
choices: card or bank, Cash App Pay, or cash at a store. Cash generates a code (a scannable
barcode once PayNearMe is live) to bring to Walmart, 7-Eleven, CVS, Dollar General or
Walgreens.

**Loan** shows full transparency — principal balance, rate, term, purchase price, down
payment, amount financed, escrow balance, trust details, the complete amortization
schedule, and a payoff estimate. The monthly payment breakdown separates principal and
interest from escrow, taxes, insurance, utilities and servicing fees. An extra payment
calculator lets them enter an amount and see months saved and interest saved.

**Docs** holds their copies of the same five shared folders you manage.

**Settings** has location sharing (off by default), a data export, legal links, and
account deletion.

---

## Consent and privacy

Buyers must accept the Terms of Use and Privacy Policy before they can reach any loan
data, send a message, or make a payment — the server returns HTTP 451 on every one of
those routes until both boxes are checked. Acceptance is recorded with version, timestamp,
IP, and user agent in a `consents` audit table. Change the legal text and bump
`TERMS_VERSION`, and every buyer is re-prompted.

Location sharing is optional, off by default, and shows a full disclosure before the
device permission prompt. Turning it off deletes the stored history. Every feature works
without it.

Both `public/privacy.html` and `public/terms.html` are drafts marked as templates.
Have an attorney review them before you publish — seller-financed real estate is heavily
state-regulated.

---

## Automated notices

An hourly sweep checks every active loan. When a scheduled payment is past its due date
plus the grace period and nothing covering it has been confirmed on the ledger, a late
notice goes out. Past `LEGAL_NOTICE_DAYS` (15 by default) it escalates to a notice of
default. Each notice records when it was sent and when the buyer opened it — the loan page
shows ✓✓ with the read timestamp.

A payment only counts as confirmed once it's on the ledger: admin-recorded payments,
Stripe postings, or cash codes you marked paid. A buyer saying they paid doesn't stop a
notice until you confirm receipt.

Two things to raise with counsel: an in-app read receipt is useful evidence but generally
does not substitute for legally required service methods like certified mail for
forfeiture or eviction notices, and the notice templates in `server.js` are generic — have
them reviewed against your state's requirements.

---

## Payments

Stripe handles card, bank transfer (ACH), and Cash App Pay. PayNearMe handles cash at
62,000+ retail locations. Neither the app nor you ever sees a card or bank account number.

Without PayNearMe credentials the cash flow still works manually: the buyer generates a
code, brings cash to a store or to you, and you mark it paid in the admin portal, which
posts it to the ledger. When your merchant account is approved, set the environment
variables and the same flow becomes a real scannable barcode that posts automatically.

---

## Files

`server.js` holds the API, company scoping, and the notice sweep. `db.js` is the schema,
migrations, and seeding. `loan.js` is the servicing engine — amortization, payment
allocation, payoff. `payments.js` wraps Stripe and PayNearMe. `ai.js` handles document
extraction. `public/tenant.html` and `public/admin.html` are the two front ends, each
self-contained. `public/privacy.html`, `terms.html`, `support.html` and
`delete-account.html` are the public pages the app stores require. `test.js` is the suite.

---

## Before going live

Change the seeded password. Run behind HTTPS. Set `APP_SECRET` to a fixed random value so
sessions survive restarts. Point `DATA_DIR` at a persistent volume and back it up — it
holds every loan record and uploaded document. Set `SIGNUPS_OPEN=false` until you're ready
for other companies. And since the app stores names, contact details, financial records,
and optionally location, confirm your privacy policy and data handling meet your state's
requirements before collecting real data.
