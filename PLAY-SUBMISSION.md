# Porch Pay — Google Play submission

App: **Porch Pay** · `com.porchpay.app` · Play app ID `4973047412575427537`
Status: **Draft.** Nothing has been sent for review. Nothing is public.

Play's own dashboard counter now reads **10 of 11 complete**. The only remaining item is
uploading the store graphics.

---

## Done, and verified by re-reading the saved page

| Section | What it says now |
|---|---|
| Store listing — app name | Porch Pay |
| Store listing — short description | Pay your land contract, track your balance, and keep your documents in one app. |
| Store listing — full description | 1,654 characters, saved (text at the bottom) |
| Store settings — category | App · Finance |
| Store settings — contact | servicing@saapm.com · +1 810 242 0422 · /support |
| App content — Privacy policy | https://porchpay-production.up.railway.app/privacy |
| App content — Sign in details | Demo buyer account · appreview@porchpay.app · review instructions |
| App content — Target audience | 18 and over |
| App content — Ads | No ads |
| App content — Data safety | **Submitted** — full questionnaire, all 11 data types |
| App content — Government apps | No |
| App content — Health apps | No health features |
| App content — Advertising ID | No |
| App content — Content ratings | All Other App Types · questionnaire complete |
| App content — Financial features | My app doesn't provide any financial features |
| Production — Countries / regions | United States only (Targeted: 1) |

### Why the content rating and the target audience don't match — and shouldn't

Two different questions, and it is normal for them to differ:

- **Content rating (IARC)** — what is *in* the app. Everyone / PEGI 3, because there is no
  violence, sexuality, language, drugs or gambling.
- **Target audience** — who the app is *for*. **18 and over**, because it services a home
  purchase contract held by an adult.

Almost every business app on Play is rated Everyone and targets adults; a bank app is rated
Everyone. Widening Target audience to include under-13 would pull Porch Pay into Google's
**Families policy** — Designed for Families review, COPPA obligations, ad-content
restrictions and a separate approval track — and would contradict both the privacy policy
("not directed to children and is not intended for anyone under 18") and the 18+ already
given to Apple. Leave it at 18+.

### On the Financial features answer

Google's Financial Services policy defines personal loans as lending *"on a nonrecurring
basis, **not for the purpose of financing purchase of a fixed asset**"* and lists
*"Examples not included: **Mortgages**, car loans, revolving lines of credit."* Counsel
confirmed a land contract is a mortgage substitute, which puts it on the excluded side of
Google's own line. None of the other twenty categories describe the app either — it is not
mobile payments or a digital wallet (one payer, one payee, one obligation, with Stripe as
processor and no stored-value instrument), and not Buy now pay later (that is short-term
point-of-sale credit, not multi-year seller financing on real property).

The declaration is amendable at any time if Google's review reads it differently.

---

## What's left — one thing

### 1. Upload the graphics (the only reason "Set up your store listing" is still open)

Play's asset picker opens a native file dialog I can't reach, so these eight uploads are
hand work. Everything is sized and sitting in one folder, ready to multi-select:

`Desktop\AI Project Folders\porchpay\store-assets\`

| Slot on the listing page | File(s) | Size |
|---|---|---|
| App icon | `play-icon-512.png` | 512×512 |
| Feature graphic | `play-feature-graphic-1024x500.png` | 1024×500 |
| Phone screenshots | all 6 in `play-phone\` | 1080×1920 |
| 7-inch tablet screenshots | all 6 in `play-tablet7\` | 1200×1920 |
| 10-inch tablet screenshots | all 6 in `play-tablet10\` | 1600×2560 |

Then press **Save** on the store listing. The text is already there — don't retype it.

The tablet sets are new. Play marks both as required and will not accept a 1080×1920 phone
shot in a tablet slot. They are the same six screens re-framed to tablet proportions.

---

## Then: the build

Codemagic's `porchpay-android` workflow can publish to Play, but **Google requires the first
release of a new app to be uploaded through the Console by hand.** So:

1. Download the `.aab` from the Codemagic build.
2. Play Console → **Test and release → Production → Create new release** → upload it.
3. From the second release onward, the pipeline takes over.

One thing to watch when the bundle lands: if Play warns that the manifest declares
`com.google.android.gms.permission.AD_ID` while our declaration says the app does not use
the advertising ID, that is a transitive dependency of Firebase Messaging, not something we
use. The fix is a one-line `tools:node="remove"` in the manifest, not a changed declaration.

---

## What the Data safety declaration says

It is submitted, but it is amendable any time. If any of this reads wrong to you, say so and
I'll change it.

- **Shared with third parties: none.** Stripe, Twilio, Lob, Firebase and the email provider
  are service providers processing on your behalf, which Google excludes from "sharing".
- **Collected:** Name · Email address · User IDs · Address · Phone number ·
  User payment info · Purchase history · Other financial info · Other in-app messages ·
  App interactions · Device or other IDs
- **Not collected:** location of either kind, photos, audio, files, contacts, calendar,
  browsing history, health, installed apps, search history.
- Every type: collected, not shared, not processed ephemerally; purpose = app functionality,
  plus account management / developer communications where they apply.
- **Required** for all of them **except Device or other IDs**, which is optional — that's the
  push token, and you only get one if the buyer turns notifications on.
- Encrypted in transit: **Yes**. Users can request deletion: **Yes**, at `/delete-account`.
  Account creation: the app doesn't create accounts; buyers sign in with an account created
  outside it ("out of app identification").

---

## The full description, as saved

> Porch Pay is the payment and account app for buyers purchasing a home on a land contract
> or contract for deed through SAA Property Management, LLC.
>
> If you are buying your home on contract, Porch Pay puts your whole account in one place:
> what you owe, when it is due, what you have already paid, and where your balance stands
> today.
>
> **WHAT YOU CAN DO**
>
> • Make a payment — pay by debit card or bank transfer, on your schedule, and get a receipt right away.
> • See what is due — your next payment amount and due date, plus the taxes and insurance held in escrow.
> • Watch your balance come down — principal, interest and current payoff, updated after every payment.
> • Read your full history — every payment you have made, with a receipt for each one.
> • Keep your documents — your contract, your notices and your year-end statements, always available.
> • Message your servicer — ask a question and get the answer in writing, without a phone call.
> • Get reminders — a notification before a payment is due, so nothing gets missed.
>
> **FOR EXISTING BUYERS**
>
> Porch Pay is not a lender. It does not offer loans, credit, financing, or any application
> for financing. It is the servicing app for a home purchase contract you already have with
> SAA Property Management, LLC. Your servicer gives you your sign-in details — there is no
> public sign-up.
>
> **YOUR ACCOUNT IS YOURS**
>
> You see only your own property, your own balance and your own documents. Payments are
> processed by Stripe; Porch Pay never stores your full card or bank account number.
>
> Questions about your account? Message your servicer from inside the app, or visit
> https://porchpay-production.up.railway.app/support

That "not a lender" paragraph is deliberate. It's the same sentence your attorney will want
to look at for the Financial features question.

---

## Still open from before

- **Push notifications on iOS.** Unresolved. The entitlement is in the signed binary and
  permission is granted, but `register()` returns neither a token nor an error. Next step is
  reading the device log — iMazing on Windows, since there is no Mac.
- **`SIGNUP_TOKEN` in Railway.** It has been used. Delete it.
- **The PROGRAM ADMIN / white-label build.** Deferred by agreement. Admin-side only, so it
  ships without app review whenever you want it.
