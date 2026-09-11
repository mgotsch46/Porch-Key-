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

### Ready on iOS (Sep 11, 2026, verified by reloading the page)

- Screenshots: six 1320x2868 files in the 6.9 inch iPhone slot, in order (Properties, Comms, House, Conversation, Crew, Payments); smaller iPhone sizes use them.
- Build 3 (1.0) attached.
- App Review Information: sign-in required, user `demo-admin@porchpay.app`, password entered by Marisa, contact Marisa Gotsch +1 651 894 3635 marisa@reneweqllc.com, review notes below.
- Only step left: **Add for Review**, then **Submit**. Held on purpose (next section).

### Hold before submitting to Apple

Apple rejected the buyer app on Sep 9 under Guideline 5.1.1(ix): apps in regulated financial services must come from an **organization** developer account, and this account is still an individual one. The admin app is on the same account and services the same loans, so it will get the same rejection. The conversion request to RENEWEQ, LLC is open (case 102957813212; see `claude/porch-pay-app-store-rejection.md` in the project). Submit the admin app the day App Store Connect > Business shows RENEWEQ, LLC.

---

## Google Play

The Play developer account (REQ-SF, ID 5172876456754898309) is already an **Organization** account, so Google's organization requirement for financial apps is met, and the 12-tester closed test rule for new personal accounts does not apply. Porch Pay (buyer) is already in Production there.

App ID `4972096024930091966`.

### Done (Sep 11, 2026)

| Section | Value |
|---|---|
| App created | Porch Pay Admin, English (US), App, Free |
| Store listing | Title, short and full description, icon, feature graphic, 6 phone, 6 7-inch and 6 10-inch tablet screenshots (fictional data) |
| Store settings | Category Business; servicing@saapm.com, +1 810 242 0422, support URL |
| Privacy policy | https://porchpay-production.up.railway.app/privacy |
| Ads | No ads |
| Government apps | No |
| Advertising ID | No (the bundle declares no AD_ID permission) |
| Health | My app does not have any health features |
| Financial features | My app doesn't provide any financial features |
| Content rating | All Other App Types. Downloaded content No. User content sharing **Yes** (staff message buyers and crews), not the primary content, no public nudity or violence, no block, report or moderation tools, interactions limited to invited people. Online content No, age-restricted products No, location sharing No, digital purchases No, cash rewards No, browser No, news/education No. Result: Everyone / PEGI 3 / ClassInd All ages, interactive element "Users Interact". |
| Production countries | United States (1) |
| Production release | Draft saved: bundle versionCode 26, versionName 1.0, release name "26 (1.0)", en-US notes |
| Android developer verification | com.porchpay.admin shows **Registered** (3 keys) |

### Data safety (answers entered, saved as draft)

Blocked from final submit until Target audience is done, which is blocked until Sign in details is saved.

- Collects data: Yes. Encrypted in transit: Yes.
- Account creation: the app does not create accounts; users sign in with accounts created outside the app, **through employment or enterprise accounts** (the company owner creates staff accounts on the web).
- Deletion: Yes. Delete account URL and delete data URL both `https://porchpay-production.up.railway.app/delete-account`. That page now covers PorchPay Admin: staff delete on the spot, a company owner files a request (commit 2e7d160).
- Shared with third parties: none.
- Collected, not ephemeral, required, purpose App functionality: Name, Email address, User IDs, Address, Phone number, Other financial info, Other in-app messages, App interactions. Account management is added for Name, Email, User IDs and Phone; Developer communications for Email.
- Device or other IDs: collected, not ephemeral, **optional** (the push token), App functionality.

### Still to do on Play

1. **Sign in details**: name "Demo staff account", user `demo-admin@porchpay.app`, reviewer notes and the full-access box are filled in. Marisa types the password, clicks Add, then Save.
2. **Target audience**: 18 and over (same reasoning as the buyer app in PLAY-SUBMISSION.md).
3. **Data safety**: open it, go to Preview, Save (answers above are already in).
4. **Production release**: open the draft, Next, Save, then Publishing overview > Send changes for review. Managed publishing is off, so the app goes live when Google approves it.
5. **Push on Android**: this build ships without push because the Firebase config only knows com.porchpay.app. Add an Android app for com.porchpay.admin in Firebase, upload the new google-services.json to Codemagic (GOOGLE_SERVICES_JSON), rebuild.

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
