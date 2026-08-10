# PorchPay — App Store & Google Play Submission Checklist

The buyer app is a PWA. To list it in the stores you wrap it in a thin native shell
(Capacitor) that loads your deployed URL. Everything below is what the reviewers check.

---

## Already built into the app

| Requirement | Where it lives |
|---|---|
| Terms + Privacy acceptance before any data access | Consent gate on first sign-in; server returns HTTP 451 on every loan, payment, and messaging route until both boxes are checked |
| Consent audit trail (who, when, what version, IP) | `consents` table; visible to admin on the buyer's record |
| Re-consent when legal text changes | Bump `TERMS_VERSION` — every buyer is re-prompted |
| Public Privacy Policy URL | `/privacy` |
| Public Terms of Use URL | `/terms` |
| Public Support URL | `/support` |
| **In-app account deletion** (Apple 5.1.1(v), Play policy) | Settings → Delete my account |
| **Web account deletion URL** (Play requirement) | `/delete-account` — works signed out |
| Data export / access right | Settings → Download my data |
| Location: optional, off by default, prominent disclosure before the OS prompt | Settings → Location sharing; full disclosure dialog first |
| Location: revocable, revoking deletes history | Same screen; server deletes all pings |
| No tracking across apps, no ad SDKs, no data sale | Nothing of the kind is in the codebase |
| Company data isolation | Every query scoped by `company_id`; 16 automated isolation tests |

---

## Before you submit

### 1. Legal text — have an attorney review it
`public/privacy.html` and `public/terms.html` are working drafts marked as templates.
Seller-financed real estate is heavily state-regulated. Get counsel to review both,
then remove the yellow "template" callouts.

Also fill in real contact details in `public/support.html` — reviewers do check that
the support URL loads and has a way to reach a human.

### 2. Apple — Privacy Nutrition Labels
In App Store Connect, declare these under App Privacy. Answer honestly; mismatches
between the label and app behavior are a common rejection.

| Data type | Collected | Linked to user | Used for tracking | Purpose |
|---|---|---|---|---|
| Name | Yes | Yes | No | App Functionality |
| Email address | Yes | Yes | No | App Functionality |
| Phone number | Yes | Yes | No | App Functionality |
| Physical address | Yes | Yes | No | App Functionality |
| Payment info | No* | — | — | *Handled by Stripe/PayNearMe; the app never receives card or bank numbers |
| Credit info / financial info | Yes | Yes | No | App Functionality (loan balance, payment history) |
| Precise location | No | — | — | — |
| Coarse location | Yes (optional) | Yes | No | App Functionality — user-enabled only |
| Messages / user content | Yes | Yes | No | App Functionality |
| User ID | Yes | Yes | No | App Functionality |
| Usage data / diagnostics | No | — | — | — |

### 3. Google Play — Data Safety form
Mirror the table above. Then specifically declare:

- **Data is encrypted in transit** — yes (serve over HTTPS; Railway does this automatically).
- **Users can request data deletion** — yes, and give both URLs: in-app path and `https://yourdomain.com/delete-account`.
- **Location**: declare as *approximate location*, optional, App functionality. You do **not**
  need background location — do not request it, or you'll trigger the background location
  declaration review.
- **Financial info**: declare "User payment info: No" and "Purchase history: Yes" (payment
  records), "Credit score: No", "Other financial info: Yes" (loan balance).

### 4. Google Play — financial services policy ⚠️
Play has a **Personal Loans** policy. PorchPay services loans rather than originating
them, but reviewers often apply the policy to anything loan-related. Be ready to:

- Declare the app is a servicing tool for existing seller-financed contracts, not a lender
  or loan marketplace.
- Provide, if asked: a representative example of loan terms (APR, term, total cost),
  your company's registration/licensing information, and a statement that you do not
  offer short-term personal loans (loans with repayment in full within 60 days are banned).
- Complete the **Financial features declaration** in Play Console (Policy → App content).

Talk to your attorney about whether your state requires a mortgage servicer or
loan originator license for seller-financed contracts — several states do, and Play
and Apple may both ask for it.

### 5. Apple — payments (this one trips people up)
Loan payments are for **real-world goods and services outside the app**, which Apple's
Guideline 3.1.3(e) / 3.1.5(a) exempts from In-App Purchase. You use Stripe and PayNearMe,
which is correct and allowed. If a reviewer flags it, respond that the app collects
payments for a real estate loan on physical property, not for digital content.

### 6. Account for the reviewer
Both stores require a working demo login. Create a real buyer account with sample loan
data and put the credentials in App Store Connect's *App Review Information* and Play's
*App access* section. Note in the review notes: "Servicer creates buyer accounts; there
is no public self-registration in the buyer app."

### 7. Required assets
- App icon 1024×1024 (start from `public/icon.svg`)
- iPhone screenshots: 6.7" and 6.5" displays
- Android: phone screenshots, plus a 1024×500 feature graphic
- Short description (Play, 80 chars) and full description
- Age rating questionnaire → this app rates 4+ / Everyone
- Category: **Finance**

---

## Wrapping the PWA for the stores (Capacitor)

```bash
npm install @capacitor/core @capacitor/cli
npx cap init PorchPay com.yourcompany.porchpay
```

Set `capacitor.config.json`:

```json
{
  "appId": "com.yourcompany.porchpay",
  "appName": "PorchPay",
  "webDir": "public",
  "server": { "url": "https://your-app.up.railway.app", "cleartext": false }
}
```

Then:

```bash
npx cap add ios
npx cap add android
npx cap open ios      # build & archive in Xcode
npx cap open android  # build a signed bundle in Android Studio
```

**iOS — add to `Info.plist`** (required, or the app crashes when location is requested):

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>PorchPay can share your approximate location with your loan servicer for account
verification and delivery of documents. This is optional — every feature works without it.</string>
```

**Android — `AndroidManifest.xml`** needs only:

```xml
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
```

Do **not** add `ACCESS_FINE_LOCATION` or `ACCESS_BACKGROUND_LOCATION` — the app doesn't
need them and both trigger extra review.

Accounts you'll need: Apple Developer Program ($99/year) and Google Play Developer
(one-time $25).

---

## Admin side

The admin portal stays on the web (and TestFlight if you wrap it separately). It is not
subject to the consumer-facing store requirements above, but if you do submit it to
TestFlight, use the same Capacitor setup pointed at `/admin`.
