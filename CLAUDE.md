# PorchPay

Loan servicing and property management software, a product of RenewEQ, LLC. Servicing companies use it white labeled as their own, each with its own borrowers, properties and payments; SAA Property Management, LLC is one of them. Built for contract for deed and land trust beneficial interest deals with tenant buyers, which is why off the shelf tools like Buildium and Innago do not fit: PorchPay handles declining balances, amortization, interest accrual, escrow, and payoff mechanics.

Node and Express with better-sqlite3 on a persistent Railway volume (`DATA_DIR`).

## Run it locally
```
npm install
node server.js
```

## What lives where
- `server.js` entry point, `db.js` schema and queries
- `public/` the web app the staff use
- `mobile/porchpay` and `mobile/porchpay-admin` the two mobile apps
- `tools/` helper scripts including `admin-store-shots.js`
- `store-assets/admin/` finished App Store and Play Store screenshots plus `app-release.aab`
- `sample-notices/` notice templates
- `ADMIN-SUBMISSION.md`, `APP-STORE-CHECKLIST.md`, `PLAY-SUBMISSION.md`, `DEPLOY.md` are the current process docs

## Deploy
Railway project "Porch Key" (`c7898d2a-4b5e-4dc3-b93e-68893584bfc2`). Pushing to `main` auto deploys.
Mobile builds go through Codemagic (`codemagic.yaml`).

## Integrations
- Twilio for SMS and voice on 810-242-0422 (A2P approved, and published on `support.html`)
- SendGrid multi identity email, `servicing` and `legal` identities, routed automatically by notice type and days past due, with an explicit override available
- PayNearMe and Cash App Pay for payments

## Vocabulary
"BOG" means boots on ground: local field reps who physically check properties, handle lockouts, take photos, and meet contractors. Other roles are tenant buyers and co-buyers.

## Voice and texting, verified working September 21, 2026
The 810 number's voice and messaging webhooks point at PorchPay. Inbound calls ring the owner's cell (with a press 1 screen) and the browser softphone at the same time, and unanswered calls fall through to a voicemail greeting that records and transcribes. The softphone in the web app can place and receive calls. Settings → Texting → "Check my calling setup" asks Twilio live and lists the last eight calls; use it before guessing. Railway http logs show the Twilio webhook trail (`/api/voice/incoming` → `staff-screen` → `vm-fallback`) for any call.

Lesson: Twilio reports `DialCallStatus=completed` for a screened cell leg that picked up and hung up without pressing 1. Only `DialBridged=true` means a person was actually connected.

## Open items, current focus first
1. **Inbound communication routing.** The goal is one unified communication log per property across SMS, voice, and email. Inbound SMS may only resolve contacts scoped to vendors rather than the full contacts table, so buyer messages arrive with no `contact_id` or `property_id`. Fix that first.
2. Verify inbound records actually get `property_id` and `contact_id` attribution. Both columns already exist on `email_log`.
3. The admin app Comms section needs reorganizing per property and a much cleaner look.

## Known feature gaps against competitors
1098 and 1099-INT generation, a double entry or trust accounting ledger, deeper escrow disbursement handling, payoff letter generation, and compliance posture work (Dodd-Frank, SAFE Act, Reg Z, state contract for deed statutes).

## App Store seller name
The Apple developer account is an organization enrollment for RenewEQ, LLC, and Apple will not show a DBA as the seller. Every app on that account must carry the RenewEQ, LLC name in its store name, copyright and in app pages, or App Review rejects it under Guideline 5.1.1(ix). Details in `ADMIN-SUBMISSION.md`.

## Decided Sep 22, 2026
PorchPay is a product for other servicing companies, not only an internal tool (Marisa confirmed). Weigh the competitor gaps above with that in mind.
