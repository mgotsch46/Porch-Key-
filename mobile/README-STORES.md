# PorchPay on the App Store and Google Play

Two apps, one codebase. Each store app is a thin native shell (Capacitor) around the
live site, so every deploy updates both stores' apps instantly — store review is only
needed again when the shell itself changes.

| App            | Bundle / Application ID | Loads              |
|----------------|-------------------------|--------------------|
| PorchPay       | com.porchpay.app        | https://porchpay-production.up.railway.app/       |
| PorchPay Admin | com.porchpay.admin      | https://porchpay-production.up.railway.app/staff  |

Same colors (#54A32F on #F7FBF3, dark ink #16220D) and the same logo set from /public.

## One-time setup on a machine with Node 18+
    cd mobile/porchpay        # or mobile/porchpay-admin
    npm install
    npx cap add ios           # Mac only
    npx cap add android
    npx cap sync

## Android (works on Windows)
    npx cap open android      # opens Android Studio → Build → Generate Signed App Bundle
Upload the .aab in Play Console → your app → Production (or Internal testing first).
Keep the signing keystore safe — losing it means losing the app listing.

## iOS (needs a Mac — or Codemagic/Appflow cloud build)
    npx cap open ios          # opens Xcode
Set the Team (your Apple Developer account), then Product → Archive → Distribute →
App Store Connect. The build appears in TestFlight within the hour.

No Mac? codemagic.io free tier builds iOS from the GitHub repo: connect the repo,
pick the workflow in mobile/porchpay*/codemagic.yaml, add your App Store Connect
API key, and every push can ship a TestFlight build.

## Store listing essentials
- Privacy policy URL: https://porchpay-production.up.railway.app/privacy
- Support URL:        https://porchpay-production.up.railway.app/support
- Category: Finance (buyer app) / Business (admin app)
- The buyer app's App Store review needs a demo login: create a test buyer
  (Settings → Tenant Buyers) and put its credentials in the review notes.
