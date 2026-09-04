@echo off
setlocal
title Porch Pay - Deploy

echo.
echo  ========================================
echo   PORCH PAY - DEPLOYING YOUR CHANGES
echo  ========================================
echo.

cd /d "%~dp0"

echo  Clearing stale lock files...
del /f /q ".git\index.lock" >nul 2>&1
del /f /q ".git\HEAD.lock" >nul 2>&1
del /f /q ".git\objects\maintenance.lock" >nul 2>&1
del /f /q ".git\refs\heads\main.lock" >nul 2>&1

where git >nul 2>&1
if errorlevel 1 (
  echo.
  echo   GIT IS NOT INSTALLED
  echo   Get it from https://git-scm.com/download/win
  echo   Install with all defaults, then run PUSH.bat again.
  echo.
  pause
  exit /b 1
)

set "MSGFILE=%TEMP%\porchpay_commit_msg.txt"
if exist "%MSGFILE%" del /f /q "%MSGFILE%" >nul 2>&1

>>"%MSGFILE%" echo Make the binary say which build it is
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo The page is served from Railway, so it has no idea which .ipa is wrapping
>>"%MSGFILE%" echo it. A web fix and a native fix look identical from the outside, and that
>>"%MSGFILE%" echo ambiguity cost most of an evening: every time push failed, "is the new
>>"%MSGFILE%" echo build even installed?" could not be answered by anyone.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Capacitor can append to the WebView user agent, so the build now stamps
>>"%MSGFILE%" echo its own number in - PorchPayBuild/N - and the phone reports it with every
>>"%MSGFILE%" echo push diagnostic. The question is now answered by data instead of by
>>"%MSGFILE%" echo asking someone to go and look in TestFlight.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Also added: /api/push/diag. iOS registration failure is silent on the
>>"%MSGFILE%" echo device AND invisible on the server - APNs simply never calls back, so
>>"%MSGFILE%" echo there is nothing to log. The phone posts what it saw instead: outcome,
>>"%MSGFILE%" echo reason, bridge/plugin/permission state, iOS version. Without a Mac there
>>"%MSGFILE%" echo is no device console to read, and this is the substitute.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ---
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Entitle the build where it survives, and prove it from the binary
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo The last fix wired CODE_SIGN_ENTITLEMENTS into project.pbxproj and then
>>"%MSGFILE%" echo ran `npx cap sync ios` on the very next line. cap sync regenerates that
>>"%MSGFILE%" echo file. The setting was written, checked, passed the check, and was thrown
>>"%MSGFILE%" echo away seconds later - and `xcode-project use-profiles` rewrites signing
>>"%MSGFILE%" echo settings again after that.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo So Build 8 passed a green entitlement check and shipped with no
>>"%MSGFILE%" echo entitlement. The check was real; it was measured before the thing that
>>"%MSGFILE%" echo undid it. A guard placed upstream of the step that breaks what it guards
>>"%MSGFILE%" echo is worse than no guard, because it is believed.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo - The entitlement is now written and wired in the SIGNING step, after
>>"%MSGFILE%" echo   cap sync and after use-profiles have both finished with the project.
>>"%MSGFILE%" echo - Both halves are required: the file must contain aps-environment AND the
>>"%MSGFILE%" echo   project must reference the file. Either alone silently does nothing.
>>"%MSGFILE%" echo - And the build now reads the entitlement back OUT OF THE SIGNED .app
>>"%MSGFILE%" echo   with codesign -d --entitlements. Everything else describes intent;
>>"%MSGFILE%" echo   that one reads the artefact. No aps-environment, no build.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Symptom this was chasing: bridge yes, native true, platform ios, plugin
>>"%MSGFILE%" echo yes, permission granted - and register() returning neither a token nor an
>>"%MSGFILE%" echo error, forever. APNs does not answer an app that is not entitled.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ---
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Push was never entitled, so no iPhone could ever register
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo devices: 0. Not one device token, on the whole server, ever. The build
>>"%MSGFILE%" echo wrote App.entitlements with aps-environment=production and then NOTHING
>>"%MSGFILE%" echo told Xcode to use it - CODE_SIGN_ENTITLEMENTS was never set, so the file
>>"%MSGFILE%" echo sat in the source tree and was ignored at signing. The shipped app had
>>"%MSGFILE%" echo no push entitlement at all.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo The failure is silent end to end: iOS shows the permission prompt, the
>>"%MSGFILE%" echo person taps Allow, APNs then declines to issue a token, and no error
>>"%MSGFILE%" echo reaches the app. It looks exactly like "notifications don't work on this
>>"%MSGFILE%" echo phone". Both iOS workflows now set CODE_SIGN_ENTITLEMENTS and FAIL THE
>>"%MSGFILE%" echo BUILD if the reference is missing - a binary that claims push and cannot
>>"%MSGFILE%" echo do it should not reach TestFlight.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo THE ADMIN APP NEVER EVEN ASKED. staff.html opened with
>>"%MSGFILE%" echo   if(!('serviceWorker' in navigator)^|^|!('PushManager' in window)) return;
>>"%MSGFILE%" echo PushManager does not exist in an iOS WebView, so inside the store build
>>"%MSGFILE%" echo that returned on the first line, every time. The app never requested
>>"%MSGFILE%" echo permission, which is why it never appeared in the phone's Settings under
>>"%MSGFILE%" echo Notifications. It now takes the native path and registers a device token.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo THE BUYER APP asks on its own now, right after sign-in, instead of hiding
>>"%MSGFILE%" echo behind a button nobody finds. iOS will not let an app switch notifications
>>"%MSGFILE%" echo on by itself - the system prompt is the only way - but nothing says the
>>"%MSGFILE%" echo person has to go looking for it.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo And the button can no longer be dead. It reports while registering, says
>>"%MSGFILE%" echo so if Apple refuses, gives up after ten seconds rather than waiting for a
>>"%MSGFILE%" echo token that is never coming, and prints what it can see:
>>"%MSGFILE%" echo   bridge / native / platform / plugin / web Notification
>>"%MSGFILE%" echo Every one of those is a different bug with the same symptom.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo 886 passed, 0 failed.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ---
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo A second company must not spend the host's money
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Every integration fell back to the environment when a company had no key
>>"%MSGFILE%" echo of its own:  (company.stripe_secret_key) ^|^| process.env.STRIPE_SECRET_KEY.
>>"%MSGFILE%" echo Right for the company that OWNS the deployment - those Railway variables
>>"%MSGFILE%" echo are theirs. Badly wrong for anybody else.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo A company created afterwards inherited the host's LIVE Stripe key, Twilio
>>"%MSGFILE%" echo number, Lob account and sending domain. A buyer of that company tapping
>>"%MSGFILE%" echo Pay opened a real Checkout session on the host's Stripe account, charging
>>"%MSGFILE%" echo a stranger's card into the host's balance. Their letters carried the
>>"%MSGFILE%" echo host's return address and were billed to the host's Lob account. Their
>>"%MSGFILE%" echo email went out from the host's verified domain.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Found while building the App Store review account, which is exactly the
>>"%MSGFILE%" echo case that would have hit it: the first thing a reviewer does is tap
>>"%MSGFILE%" echo "Make a payment".
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo - The host is the first company on the server; it keeps the environment.
>>"%MSGFILE%" echo   Every company created after it starts with nothing until it is set up.
>>"%MSGFILE%" echo - A caller with NO company in hand - a sweep, a webhook, a server-wide
>>"%MSGFILE%" echo   "is Stripe connected" check - is a host-level question and is unchanged.
>>"%MSGFILE%" echo - The buyer checkout used to replace a keyless company with null before
>>"%MSGFILE%" echo   calling Stripe, and null meant the host. That substitution was the leak.
>>"%MSGFILE%" echo   The company is always passed now.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo 13 tests: the host still reaches all four services through the
>>"%MSGFILE%" echo environment, a second company reaches none of them, and a second company
>>"%MSGFILE%" echo with its OWN key works again - this restricts inheritance, not features.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo 882 passed, 0 failed.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ---
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Let a closed server be given one company without opening it to everyone
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Apple will not review an app it cannot sign into, and PorchPay has no
>>"%MSGFILE%" echo self-service sign-up, so a reviewer needs a real login. Building that
>>"%MSGFILE%" echo account inside SAA would seat a stranger's session next to real buyers'
>>"%MSGFILE%" echo balances and default notices. It needs its own company.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo But SIGNUPS_OPEN=false, correctly - this server holds other people's loan
>>"%MSGFILE%" echo ledgers. The only way to add a company was to open signup to the whole
>>"%MSGFILE%" echo internet for a few minutes, which is a worse thing to do than the thing
>>"%MSGFILE%" echo it was needed for.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo A closed server now accepts a signup carrying a matching SIGNUP_TOKEN:
>>"%MSGFILE%" echo one secret, held by one person, revoked by changing a variable. It is
>>"%MSGFILE%" echo also the primitive white-label onboarding wants - a client gets a key
>>"%MSGFILE%" echo when it is their turn, and the door stays shut the rest of the time.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo - Compared in constant time, and only when the token is 16+ characters.
>>"%MSGFILE%" echo   A blank token must not match a blank variable, and a five-character
>>"%MSGFILE%" echo   one must not be honoured even when it is correct.
>>"%MSGFILE%" echo - 8 tests: no token, wrong token, empty token, short token, right token,
>>"%MSGFILE%" echo   and signups open again afterwards.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo seed-demo.js builds the review account through the public API - property,
>>"%MSGFILE%" echo buyer, loan, 85 payments through this month, four PDFs, a message thread.
>>"%MSGFILE%" echo Verified by signing in as a reviewer would: 17%% paid off, nothing past
>>"%MSGFILE%" echo due, no $1.00 test rows, no SANDBOX text, and invisible to SAA.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo It also refuses a weak password before it creates anything. The first run
>>"%MSGFILE%" echo used "testpassword" for both logins - on the production server, handed to
>>"%MSGFILE%" echo a stranger at Apple. Under 10 characters, a guessable word, letters only,
>>"%MSGFILE%" echo or the same password twice now stops it.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo 869 passed, 0 failed.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ---
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Stop one bad request from taking the whole server down
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Found by driving the app rather than reading it: asking to send an
>>"%MSGFILE%" echo invitation that does not exist threw a TypeError and KILLED THE NODE
>>"%MSGFILE%" echo PROCESS. Everyone signed out, every in-flight payment redirect dropped,
>>"%MSGFILE%" echo the buyer app down - from a stale tab or a mistyped URL.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo The not-found check sat BELOW the already-sent check, which read d.inv on
>>"%MSGFILE%" echo a null d. But the one-line fix is not the fix. Express 4 catches a handler
>>"%MSGFILE%" echo that throws synchronously; an ASYNC handler that throws returns a rejected
>>"%MSGFILE%" echo promise, which Express ignores and Node turns into a fatal error. Twelve
>>"%MSGFILE%" echo async routes had no try/catch. Any of them was an outage waiting.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo - Every handler is now wrapped once, where routes are registered, so a
>>"%MSGFILE%" echo   rejection reaches the error middleware instead of the process. This does
>>"%MSGFILE%" echo   not depend on ~130 route bodies each remembering their own try/catch.
>>"%MSGFILE%" echo - Anything rejecting outside a request - a sweep, a timer, a webhook retry -
>>"%MSGFILE%" echo   is logged loudly and the server keeps serving.
>>"%MSGFILE%" echo - /api/admin/comms/attach returned a 500 and a stack trace when asked to
>>"%MSGFILE%" echo   attach nothing. It now says which call or text you meant.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo THE PLATFORM ACCOUNT. super_admin was admitted to the admin and staff UIs
>>"%MSGFILE%" echo but excluded from ADMIN_ROLES on the server, so it signed in successfully
>>"%MSGFILE%" echo and got a fully rendered dashboard with NOTHING IN IT - every panel 403,
>>"%MSGFILE%" echo silently. It now gets told plainly that it maintains companies and owns
>>"%MSGFILE%" echo none, with a sign-out button.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo THE PUBLIC PAGES. Support was telling buyers to "turn off location sharing"
>>"%MSGFILE%" echo in a screen that no longer exists, and the deletion page promised to delete
>>"%MSGFILE%" echo location history the app never collects - both contradicting the privacy
>>"%MSGFILE%" echo policy one link away, on the exact pages a store reviewer opens. Fixed, and
>>"%MSGFILE%" echo now guarded by a test that scans all four pages for any claim about
>>"%MSGFILE%" echo location that is not a denial. A stale assertion in verify-features.js went
>>"%MSGFILE%" echo with them.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ISOLATION, measured rather than assumed: a second company was signed up and
>>"%MSGFILE%" echo pointed at company A's ids across all 209 admin and staff routes - 435
>>"%MSGFILE%" echo probes, reads then writes. ZERO leaks. A's loan, property, buyer, ledger and
>>"%MSGFILE%" echo notices were all intact afterwards. Buyer-to-buyer: 18 tenant reads, zero.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo 30 new tests. 861 passed, 0 failed.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ---
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Nothing goes in the post until a person has read it
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo The ladder handed a certified letter straight to Lob the moment the rung
>>"%MSGFILE%" echo fired. The first person to read that letter was the buyer - after it had
>>"%MSGFILE%" echo been printed, mailed, billed to them, and filed as evidence. None of that
>>"%MSGFILE%" echo can be taken back, and the 30-day notice is the document a forfeiture case
>>"%MSGFILE%" echo leans on. A wrong figure on it is not a typo.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Certified letters are now drafted and held. The notice itself still goes out
>>"%MSGFILE%" echo instantly by app, email and text - the buyer is not kept waiting - but the
>>"%MSGFILE%" echo envelope waits for a review task on the dashboard: read it, edit anything
>>"%MSGFILE%" echo that reads wrong, then approve or stop it with a reason.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo - Approving mails the EDITED copy, charges the flat rate once, files the PDF,
>>"%MSGFILE%" echo   and closes the task. Same idempotency key as before, so a double-click or
>>"%MSGFILE%" echo   two admins approving the same letter cannot mail or bill it twice.
>>"%MSGFILE%" echo - Stopping it requires a reason, which is kept: "why did we not mail the
>>"%MSGFILE%" echo   30-day notice" is a question with a statutory edge to it.
>>"%MSGFILE%" echo - Editing changes the LETTER only. The notice the buyer already read is left
>>"%MSGFILE%" echo   alone, and the record notes when the two differ.
>>"%MSGFILE%" echo - A blank textarea is not an edit. Mailing an empty page costs postage and
>>"%MSGFILE%" echo   proves nothing.
>>"%MSGFILE%" echo - The sweep re-notifies daily on anything still unread. It never mails on its
>>"%MSGFILE%" echo   own after a timeout - auto-sending would quietly undo the whole point.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo The Lob invoice field now has a screen. Settings shows every letter that has
>>"%MSGFILE%" echo gone with a box for what Lob actually billed, plus totals; the same box sits
>>"%MSGFILE%" echo on each notice, next to the ledger line it explains. Typing it in never moves
>>"%MSGFILE%" echo the buyer's balance - that stays the flat published rate.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Mailing by hand goes through the same read-it-first screen, and now shows
>>"%MSGFILE%" echo what the BUYER pays rather than Lob's estimate, which is what it had been
>>"%MSGFILE%" echo quoting since the flat rate went in.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Three send sites had been maintaining their own copy of "send, file the PDF,
>>"%MSGFILE%" echo post the fee". They share one routine now.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo 40 new tests, including that the ladder mails nothing on its own with Lob
>>"%MSGFILE%" echo connected, that Lob receives the corrected text, and that a stopped letter
>>"%MSGFILE%" echo bills nobody. 831 passed, 0 failed.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Caught before shipping, by running the render functions rather than reading
>>"%MSGFILE%" echo them: a second "ago" helper redeclared a const that already existed further
>>"%MSGFILE%" echo down admin.html. That is a whole-file SyntaxError - the same white screen as
>>"%MSGFILE%" echo the v-loc bug, on the admin side this time.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ---
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Charge the fee for the method the buyer picked, and a flat rate for mail
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo THE FEE. The checkout endpoint computed calcFee(..., 'card') no matter what,
>>"%MSGFILE%" echo then opened a Stripe session offering card, bank transfer and Cash App. So a
>>"%MSGFILE%" echo buyer who chose bank transfer paid the CARD fee. On a $1,790.28 payment that
>>"%MSGFILE%" echo is $52.22 instead of $5.00 - about $47 too much, taken from someone already
>>"%MSGFILE%" echo behind. The app knew better: fee-quote returns card, ach and cashapp
>>"%MSGFILE%" echo separately, and calcFee honours an ACH rate with its own cap. The quote was
>>"%MSGFILE%" echo right; the charge ignored it.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo - "New card or bank" is now two buttons: Debit or credit card, and Bank
>>"%MSGFILE%" echo   transfer, labelled "Lower fee - takes a few business days".
>>"%MSGFILE%" echo - The buyer app sends the chosen method; the fee is computed for it; and the
>>"%MSGFILE%" echo   Stripe session is restricted to it, so the quote cannot be undercut at the
>>"%MSGFILE%" echo   last step.
>>"%MSGFILE%" echo - Choosing bank transfer now shows, before committing, that the payment is
>>"%MSGFILE%" echo   only "initiated" until the money lands, and that a late charge is based on
>>"%MSGFILE%" echo   the day the money ARRIVES, not the day it was started.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo THE MAIL. Postage was billed to the buyer at whatever Lob estimated, so the
>>"%MSGFILE%" echo same certified letter could cost two buyers different amounts. It is now a
>>"%MSGFILE%" echo flat published rate - $5 first class, $15 certified, both editable - and
>>"%MSGFILE%" echo what Lob actually billed is recorded separately from the invoice.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Three numbers kept apart on purpose: Lob's estimate at send time, Lob's real
>>"%MSGFILE%" echo invoice, and what the buyer was charged. Recording the invoice later never
>>"%MSGFILE%" echo re-bills anyone.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Those amounts were previously only settable in the setup wizard, so they
>>"%MSGFILE%" echo could never be changed once a company was running. They are on the company
>>"%MSGFILE%" echo endpoint now, and an omitted field keeps its value rather than zeroing it.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Communications now opens collapsed, showing just an unread count, and does
>>"%MSGFILE%" echo not fetch the inbox until you open it.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo 11 new tests. 791 passed, 0 failed.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ---
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Stop labelling every online payment "Card"
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo postStripePayment read session.payment_method_types[0] to decide how the
>>"%MSGFILE%" echo buyer paid. That array is the list of methods we ALLOW, with card first -
>>"%MSGFILE%" echo not the one they chose. So every online payment was recorded as Card,
>>"%MSGFILE%" echo including the bank transfers, and the buyer's history showed a row reading
>>"%MSGFILE%" echo "Card - bank transfers take a few business days to clear".
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Wrong in the ledger, not just on screen: the method is what tells a buyer
>>"%MSGFILE%" echo how they paid and what the servicer sees on the row.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo - retrieveSession now expands payment_intent.latest_charge, so the redirect
>>"%MSGFILE%" echo   path reads the method off the charge, which is the only place it is true.
>>"%MSGFILE%" echo - The webhook payload does not carry the charge, so it falls back to the one
>>"%MSGFILE%" echo   thing that is certain there: only a delayed-notification method leaves a
>>"%MSGFILE%" echo   completed session unpaid, and the only one we offer is ACH.
>>"%MSGFILE%" echo - Six cases checked against the shapes Stripe actually sends, including the
>>"%MSGFILE%" echo   unexpanded-id case where payment_intent is a string.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Also: the pending sentence no longer promises "bank transfers take a few
>>"%MSGFILE%" echo business days" on a card, and the payment method label and its description
>>"%MSGFILE%" echo were rendering as one run-together string - "New card or bankDebit, credit,
>>"%MSGFILE%" echo or bank transfer" - because both were inline spans in a flex row.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ---
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Fix the white screen every buyer got at sign-in
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Removing the location feature deleted the v-loc screen but left its id in
>>"%MSGFILE%" echo the list show() iterates. $('v-loc') returned null and .classList threw -
>>"%MSGFILE%" echo before the loop reached v-app. So the app never un-hid itself and every
>>"%MSGFILE%" echo buyer, on web and on iOS, got a white screen the moment they signed in.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo The parse check I ran at the time could not have caught this: the file was
>>"%MSGFILE%" echo syntactically perfect. It only failed when the line actually ran. Nor did
>>"%MSGFILE%" echo grepping for "location" - the dead reference was the string 'v-loc' and the
>>"%MSGFILE%" echo functions were named locUi and sendPing, none of which contain that word.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo show() now skips a view that is not in the document instead of throwing on
>>"%MSGFILE%" echo it, so a missing screen can never take the whole app down again.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Swept all three pages for the same class of bug - every id referenced
>>"%MSGFILE%" echo through $() against every id defined in the markup. tenant, admin and staff
>>"%MSGFILE%" echo are clean; v-loc was the only one.

echo  Staging changes...
git add -A
if errorlevel 1 goto failed

echo  Committing...
git commit -F "%MSGFILE%"

echo  Pushing to GitHub...
echo.
git push origin main
if errorlevel 1 goto failed

del /f /q "%MSGFILE%" >nul 2>&1

echo.
echo  ========================================
echo   DONE
echo  ========================================
echo.
echo   Railway is rebuilding. Wait about 90 seconds, then reload:
echo     https://porchpay-production.up.railway.app/admin
echo.
pause
exit /b 0

:failed
echo.
echo   SOMETHING WENT WRONG - copy everything above and send it to Claude.
echo.
echo   If it says "Authentication failed": do not type your GitHub password,
echo   it will not work. Choose the browser sign-in option instead.
echo.
pause
exit /b 1
