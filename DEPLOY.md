# Deploying PorchPay to GitHub + Railway

Everything is prepped. These are the clicks on your side.

---

## 1. Push to GitHub

From the `loan-servicing-app` folder:

```bash
git init
git add .
git commit -m "PorchPay loan servicing platform"
```

Create a new **private** repo at github.com/new — name it `porchpay`, don't add a README
or .gitignore (you already have one). Then:

```bash
git remote add origin https://github.com/YOUR-USERNAME/porchpay.git
git branch -M main
git push -u origin main
```

`.gitignore` already excludes `node_modules/`, `data/`, and `.env`, so no database or
secrets get committed.

---

## 2. Create the Railway project

1. Go to railway.app → **New Project** → **Deploy from GitHub repo**
2. Authorize Railway and pick your `porchpay` repo
3. Railway detects Node and starts building. Let it finish — it'll fail health checks
   until you finish step 3, which is expected.

---

## 3. Add a persistent volume ⚠️ Do this before entering real data

SQLite writes to disk, and Railway containers reset on every deploy. Without a volume
you lose every loan on the next push.

1. In your service → **Settings** → **Volumes** → **Add Volume**
2. Mount path: `/data`
3. Size: 1 GB is plenty to start

---

## 4. Set environment variables

Service → **Variables** → paste these in (Railway accepts bulk paste):

```
APP_SECRET=<paste a generated secret>
DATA_DIR=/data
COMPANY_NAME=Your Company Name
ADMIN_EMAIL=you@youremail.com
ADMIN_PASSWORD=<a strong password>
SIGNUPS_OPEN=false
LEGAL_NOTICE_DAYS=15
```

Generate `APP_SECRET` locally with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set `SIGNUPS_OPEN=false` while it's just you — flip it to `true` when you're ready to
let other investors self-register.

---

## 5. Generate your domain, then set BASE_URL

Service → **Settings** → **Networking** → **Generate Domain**. You'll get something like
`porchpay-production.up.railway.app`.

Copy it, then add one more variable:

```
BASE_URL=https://porchpay-production.up.railway.app
```

Railway redeploys. When it's green:

- Buyer app: `https://your-domain/`
- Admin portal: `https://your-domain/admin`

Sign in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` you set. It'll make you change the
password immediately.

---

## 6. Connect Stripe

1. dashboard.stripe.com → Developers → API keys → copy the **secret key**
   (use `sk_test_…` until you've tested end to end)
2. Railway variable: `STRIPE_SECRET_KEY=sk_test_...`
3. Stripe → Developers → Webhooks → **Add endpoint**
   - URL: `https://your-domain/api/stripe/webhook`
   - Event: `checkout.session.completed`
4. Copy the signing secret → Railway variable: `STRIPE_WEBHOOK_SECRET=whsec_...`
5. In Stripe → Settings → Payment methods, enable **Cash App Pay** and **ACH Direct Debit**

Test with card `4242 4242 4242 4242`, any future expiry, any CVC. When you're satisfied,
swap in your live key.

---

## 7. Apply to PayNearMe (cash at retail)

Go to paynearme.com and request a merchant account. Tell them you're servicing
seller-financed real estate loans and need cash acceptance with API integration.
Expect underwriting — they'll want your business details.

Once approved, add:

```
PNM_API_KEY=...
PNM_SITE_ID=...
PNM_WEBHOOK_SECRET=...
```

and give them `https://your-domain/api/paynearme/webhook` as your callback URL.

Until that's live, cash codes still work — the buyer generates a code, brings cash to a
store or to you, and you mark it paid in the admin portal, which posts it to the ledger.

---

## 8. Turn on AI document reading (optional)

Get a key at console.anthropic.com, then:

```
ANTHROPIC_API_KEY=sk-ant-...
```

That switches on closing-doc extraction in New Deal and bank/credit card statement
import in Expenses. It's billed per document read — a closing package runs a few cents.

---

## 9. Custom domain (optional but worth it)

Railway → Settings → Networking → **Custom Domain**. Add `porchpay.com` or a subdomain
you own, then add the CNAME they give you at your registrar. Update `BASE_URL` to match.
You'll want this before app store submission — reviewers see the URL.

---

## Redeploying

Push to `main` and Railway rebuilds automatically:

```bash
git add .
git commit -m "what changed"
git push
```

Your volume keeps the database across deploys.

---

## Backups

The whole database is one file at `/data/app.db`, with uploads in `/data/uploads`. Get in
the habit of pulling a copy — Railway CLI makes it quick:

```bash
npm i -g @railway/cli
railway login
railway link
railway run cp -r /data ./backup-$(date +%Y%m%d)
```

Do this before any significant change, and on a schedule once you have live loans.
