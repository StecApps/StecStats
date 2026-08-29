# App Store Submission Checklist

Complete every item on a **new TestFlight/App Store build** before submitting.
The current source code cannot confirm App Store Connect product status or test
a real StoreKit payment sheet, so those checks are intentionally manual.

---

## 1 — Build and reviewer sign-in

- [ ] Increment the iOS build number and upload a new binary.
- [ ] Remove any obsolete password-based demo credential from App Store
  Connect. StecStats uses Sign in with Apple or a fresh six-digit email
  code—not an app password.
- [ ] In the **Production** Clerk environment, confirm
  `reviewer@stecstats.com` exists as the free reviewer account and that a
  fresh verification email arrives in the monitored inbox.
- [ ] Confirm the monitored inbox or approved forwarding arrangement remains
  available for the entire review window, and test requesting a second fresh
  code after the first one expires or is not used.
- [ ] On a physical iPhone or iPad, confirm **Sign in with Apple** is visible
  on the opening screen and completes successfully.
- [ ] On a clean iPad installation, enter a six-digit email code using iPadOS
  autofill or paste and confirm the app immediately leaves the login screen.
- [ ] Repeat with manual code entry and the **Verify** button or keyboard
  **Done** action.
- [ ] Confirm the resulting Profile screen shows **Unlock Pro Features**, not
  an external billing portal.
- [ ] In App Store Connect, provide a free reviewer email account and a
  reviewer-accessible way to receive its fresh 6-digit email codes throughout
  review. This account must not have an active subscription.
- [ ] In App Store Connect only, provide the current Sandbox Apple ID for the
  StoreKit payment sheet. It is not an app sign-in credential.
- [ ] Do **not** put reviewer-inbox passwords, email credentials, or Sandbox
  Apple ID passwords in Git or another source-controlled file.

## 2 — In-app purchase products

- [ ] In App Store Connect, verify both products are attached to this app
  version and submitted with the build:
  - `com.stecapps.stecstats.pro.monthly`
  - `com.stecapps.stecstats.pro.annualDeal`
- [ ] Each product has completed pricing, localization, tax/category details,
  and the required App Review screenshot.
- [ ] Confirm the subscription group, 14-day trial configuration, and
  availability are active for the intended storefront.
- [ ] In RevenueCat, confirm `$rc_monthly` points to the monthly product and
  `$rc_annual` points to the annual product in the current offering.
- [ ] On a physical TestFlight device with a Sandbox Apple ID, sign in using
  **Sign in with Apple** or the free email-code reviewer account, then open
  **Profile → Unlock Pro Features**.
- [ ] Confirm the Monthly/Annual selector appears, each price comes from
  StoreKit, and **Start Free Trial** opens Apple’s payment sheet.
- [ ] Complete a Sandbox purchase and confirm Profile shows the active Pro
  plan.
- [ ] Confirm **Restore purchases** restores an existing sandbox entitlement.
- [ ] Confirm Premium is marked **Coming Soon**, not offered for purchase.

## 3 — Account deletion

- [ ] Sign in with a throwaway account that has a player, game, and uploaded
  photo or recording.
- [ ] Go to **Profile → Delete Account**, confirm both destructive prompts,
  and verify the app returns to the welcome screen.
- [ ] Confirm the deletion copy makes clear that deleting the app account does
  not cancel an Apple subscription.
- [ ] Confirm that signing in again creates a fresh, empty account.
- [ ] Record this physical-device flow from sign-in through the final
  confirmation. Add the recording to App Review Information as requested by
  guideline 5.1.1.

## 4 — Permissions and privacy

- [ ] On a clean physical install, request camera, microphone, and photo
  library access. Confirm every native iOS prompt uses the current specific
  explanation—not an old build’s wording.
- [ ] Verify the App Store privacy nutrition label matches the data actually
  collected by the app and linked services.
- [ ] Verify the Privacy Policy and Terms links resolve from both Profile and
  the paywall.

## 5 — App Review Information

- [ ] Copy the **Notes (paste into App Store Connect)** section from
  `review-notes.md`.
- [ ] In App Store Connect only, replace the reviewer-email and Sandbox
  credential placeholders with the current review-accessible details. Do not
  commit those secrets to this repository.
- [ ] Confirm the notes direct reviewers to **Sign in with Apple** or the free
  email-code account, then **Profile → Unlock Pro Features → Start Free Trial**.
- [ ] Confirm the notes identify both submitted IAP product IDs and have no
  Stripe, web billing portal, or password-based app-sign-in path.
- [ ] Attach the required physical-device account-deletion recording (or a
  review-accessible link) to App Review Information.
- [ ] Select the newly uploaded build, submit both IAP products for review,
  and then submit the app version.

## 6 — Review reply and final checks

- [ ] Replace `[NEW BUILD NUMBER]` in `review-reply-2.1-login.md`, then paste
  that reply in App Store Connect before re-submitting.
- [ ] Do not say the corrected release build was tested until it passes on a
  physical iPad or another supported iPad-class device after a clean install.
- [ ] Confirm the account-deletion recording, Sign in with Apple check, and
  Restore purchases check were performed on a physical iOS device.
- [ ] Submit the build.

---

*Keep this checklist and the App Review note template current after every
reviewer-account, sandbox-tester, or product change.*