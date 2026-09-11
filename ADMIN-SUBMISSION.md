# PorchPay Admin: App Store and Google Play submission

App: **PorchPay Admin** (the staff app) · bundle / application ID `com.porchpay.admin`
App Store Connect app ID `6806890021` · SKU `porchpay-admin`
Loads `https://porchpay-production.up.railway.app/staff` inside a Capacitor shell.
Decision (Sep 11, 2026): public listing on both stores, iOS first, then Android.

---

## Where it stands

### App Store Connect (done, verified by reloading the page)

| Section | Value |
|---|---|
| Subtitle | Loan servicing for your team |
| Category | Business (primary), Finance (secondary) |
| Content rights | Does not contain, show or access third-party content |
| Age rating | 4+ (only "Messaging and Chat" answered Yes; everything else None/No) |
| Price | Free |
| Availability | United States only (same as the buyer app) |
| Privacy policy URL | https://porchpay-production.up.railway.app/privacy |
| App Privacy | **Published.** 9 data types, all "App Functionality", linked to the user, not used for tracking: Name, Email Address, Phone Number, Physical Address, Other Financial Info, Emails or Text Messages, User ID, Device ID, Product Interaction |
| Promotional text, description, keywords | Saved (text below) |
| Support URL | https://porchpay-production.up.railway.app/support |
| Marketing URL | https://porchpay-production.up.railway.app/ |
| Version / copyright | 1.0 · 2026 SAA Property Management, LLC |
| Release | Manually release this version |

### Still to do on iOS

1. **Build.** The admin app has never been built. Codemagic workflow `porchpay-admin-ios` builds and sends it to TestFlight. Needs someone signed in to Codemagic.
2. **Screenshots.** Upload the six files in `store-assets/admin/ios-6.9/` (1320x2868) to the 6.9 inch iPhone slot (Media Manager). The app is iPhone only, so no iPad set is needed.
3. **App Review Information.** Tick *Sign-in required*, then:
   - User name: `demo-admin@porchpay.app`
   - Password: the demo admin password chosen when DEMO-ACCOUNT.bat was run (typed by Marisa, never stored here)
   - Contact: same as the buyer app
   - Notes: text below
4. **Add build, then Add for Review.**

### Hold before submitting to Apple

Apple rejected the buyer app on Sep 9 under Guideline 5.1.1(ix): apps in regulated financial services must come from an **organization** developer account, and this account is still an individual one. The admin app is on the same account and services the same loans, so it will get the same rejection. The conversion request to RENEWEQ, LLC is open (case 102957813212; see `claude/porch-pay-app-store-rejection.md` in the project). Submit the admin app the day App Store Connect > Business shows RENEWEQ, LLC.

---

## Google Play

The Play developer account (REQ-SF, ID 5172876456754898309) is already an **Organization** account, so Google's organization requirement for financial apps is met, and the 12-tester closed test rule for new personal accounts does not apply. Porch Pay (buyer) is already in Production there.

### Steps

1. **Create app**: name *Porch Pay Admin*, English (US), App, Free, accept the two declarations.
2. **Store listing**: text below, plus `store-assets/admin/play-icon-512.png`, `play-feature-graphic-1024x500.png`, `play-phone/` (6), `play-tablet7/` (6), `play-tablet10/` (6).
3. **Store settings**: category Business; contact servicing@saapm.com, +1 810 242 0422, support URL.
4. **App content**: mirror the buyer app (see PLAY-SUBMISSION.md): privacy policy URL, no ads, target audience 18+, content rating questionnaire (all no), government no, health no, advertising ID no, financial features "My app doesn't provide any financial features", sign-in details = the same demo admin login.
5. **Data safety**: collected, not shared, encrypted in transit, deletion available at /delete-account and in the app. Types: Name, Email, Phone, Address, User IDs, Other financial info, Other in-app messages, App interactions, Device or other IDs (optional, push token).
6. **First release by hand**: download the `.aab` from Codemagic workflow `porchpay-admin-android`, then Production > Create new release > upload. After that the pipeline can publish.
7. **Android developer verification**: register the new package name `com.porchpay.admin` (Play shows a Sep 30, 2026 deadline for registration).

---

## Copy

### App Store promotional text (170 max)

Every house you service, every buyer conversation, every crew text and every payment, organized by property and ready on your phone.

### App Store keywords (100 max)

loan servicing,land contract,contract for deed,seller financing,note servicing,landlord,tenant buyer

### Description (App Store and Play full description)

PorchPay Admin is the servicer's side of Porch Pay. It puts every house you service in your pocket: who is buying it, whether they are current, what they said, what your crew is doing there, and every payment that has come in.

Built for companies that service seller-financed homes: land contracts, contracts for deed and land trust agreements.

EVERY HOUSE AT A GLANCE
Each property shows its buyer, whether the account is current or past due, and the last payment. A red dot tells you when something new has come in.

ONE CONVERSATION PER HOUSE
Buyer texts, in-app messages, crew texts, calls, voicemails, emails, notices and payments land in a single timeline for the property. Reply by text, in-app message or email from the same screen, and it files under that house automatically.

YOUR BOOTS ON THE GROUND
Keep field reps, contractors, co-buyers and lenders attached to the houses they work on. Text them from the app and their replies file under the right property.

CALL FROM YOUR BUSINESS NUMBER
Tap to call a buyer or vendor. Porch Pay rings your phone and connects the call from your business line, so your personal number stays private.

PAYMENTS AS THEY ARRIVE
See the latest payments across your whole portfolio, plus each house's payment history and next due date.

NOTIFICATIONS
Get a notification when something new comes in for one of your houses.

FOR SERVICING STAFF
PorchPay Admin is for the staff of a servicing company that uses Porch Pay. Staff accounts are set up by your company's owner, and there is no public sign up. Buyers use the separate Porch Pay app.

Porch Pay is a servicing platform. It is not a lender and does not offer loans, credit or financing.

### Play title and short description

Title: Porch Pay Admin
Short description (80 max): Service land contracts: every house, buyer message, crew text and payment.

### App Review notes

PorchPay Admin is the servicer (staff) side of Porch Pay, a loan servicing platform for seller-financed home sales (land contracts and contracts for deed). Servicing staff use it to see every house they service, message buyers, coordinate field crews and follow payments. Buyers use the separate Porch Pay app. The app does not originate loans and does not offer credit.

SIGN-IN IS REQUIRED. Staff accounts are created by the servicing company's owner on the web; there is no sign up in the app. Please use the demo credentials above.

That demo account belongs to a demo servicing company ("Porch Pay Demo Servicing") that contains no real customer data. Texting and calling are deliberately not connected for the demo company, so the review account cannot contact a real person; tapping Text or Call there shows a "not connected" message. In-app messages to the demo buyer work.

ACCOUNT DELETION: Properties screen > person icon (top right) > Delete my account. A staff account is deleted immediately. The demo account is a company owner; because the company's loan records must be retained by law, an owner's deletion is filed as a request that our support team completes (Guideline 5.1.1(v), regulated industries).

PRIVACY: Privacy Policy, Terms and Support open from the same account screen and from the sign-in screen.

PAYMENTS: The app takes no payments. It displays payments buyers make on real-estate contracts for physical property, processed outside the app.

The app requests no location, contacts, photos, camera or microphone permissions. It asks only for notification permission.

---

## Screenshots never come from the live app

Store screenshots are public. A capture of the real staff app shows real borrowers' names, addresses, phone numbers and payment history. Regenerate with `node tools/admin-store-shots.js <out>`, which runs a private server full of a fictional company and captures every size.
