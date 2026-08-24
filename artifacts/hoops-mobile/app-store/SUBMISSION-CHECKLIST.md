# App Store Submission Checklist

Complete every item on a **new TestFlight/App Store build** before submitting.
The current source code cannot confirm App Store Connect product status or test
a real StoreKit payment sheet, so those checks are intentionally manual.

---

## 1 — Build and sign-in

- [ ] Increment the iOS build number and upload a new binary.
- [ ] On a physical iPhone or iPad, confirm **Sign in with Apple** is visible
  on the opening screen and completes successfully.
- [ ] Sign in with Apple using a fresh account. Confirm the Profile screen
  shows **Unlock Pro Features**, not **Manage Billing**.
- [ ] Do not give App Review a Stripe-subscribed demo account or instructions
  that route them through a web billing portal.

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
- [ ] On a physical TestFlight device with a Sandbox Apple ID, open
  **Profile → Unlock Pro Features**.
- [ ] Confirm the Monthly/Annual selector appears, each price comes from
  StoreKit, and **Start Free Trial** opens Apple’s payment sheet.
- [ ] Complete a Sandbox purchase and confirm Profile changes to
  **Manage in App Store**.
- [ ] Confirm **Restore purchases** restores an existing sandbox entitlement.

## 3 — Account deletion

- [ ] Sign in with a throwaway account that has a player, game, and uploaded
  photo or recording.
- [ ] Go to **Profile → Delete Account**, confirm both destructive prompts,
  and verify the app signs out.
- [ ] Confirm that signing in again creates a fresh, empty account.
- [ ] Record this physical-device flow from sign-in through the final
  confirmation. Add the recording to App Review Information as requested by
  guideline 5.1.1.
- [ ] Confirm the deletion copy makes clear that account deletion does not
  cancel an Apple or web subscription.

## 4 — Permissions and privacy

- [ ] On a clean physical install, request camera, microphone, and photo
  library access. Confirm every native iOS prompt uses the current specific
  explanation—not an old build’s wording.
- [ ] Verify the App Store privacy nutrition label matches the data actually
  collected by the app and linked services.
- [ ] Verify the Privacy Policy and Terms links resolve from both Profile and
  the paywall.

## 5 — App Review Information

- [ ] Paste the current **Notes (paste into App Store Connect)** content from
  `review-notes.md`.
- [ ] Confirm the notes direct reviewers to **Sign in with Apple** and then
  the free-account IAP flow.
- [ ] Confirm no passwords, Sandbox Apple credentials, or source-control
  placeholders appear in the notes.
- [ ] Select the newly uploaded build, submit both IAP products for review,
  and then submit the app version.