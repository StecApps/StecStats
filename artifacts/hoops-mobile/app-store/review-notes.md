# App Review Information — Notes Field

> **How to use:** Paste the content under "Notes (paste into App Store Connect)" into the
> "Notes" field of the App Review Information section in App Store Connect. Update the
> credentials marked `[FILL IN]` before each submission.
>
> Keep this file up-to-date with every TestFlight / App Store submission so reviewers
> always have working credentials.

---

## Notes (paste into App Store Connect)

### Demo Account

Sign in with the following test account to explore the app without creating a new registration:

- **Email:** [FILL IN — e.g. appreviewer@stecstats.com]
- **Password:** [FILL IN]
- **Account type:** Pro (web/Stripe subscription pre-activated so both IAP and billing-portal paths are demonstrable)

*If the reviewer prefers to create their own account, registration is open via "Sign Up" on the sign-in screen.*

---

### Step-by-Step: Verifying the In-App Purchase (IAP) Flow

These steps confirm that new subscriptions go entirely through StoreKit / Apple IAP and that no external payment is involved.

1. **Sign in** with the demo account above (or create a fresh account).
2. Tap the **Profile** tab (bottom-right).
3. Because the demo account has a web subscription, you will see **"Manage Billing"** — this is the cross-platform path described in guideline 3.1.3(b). Continue to step 4 to see the IAP path instead.
4. To see the pure IAP flow: **sign out** (Profile → Sign Out), then **create a new account** with a Sandbox Apple ID (see Sandbox credentials below).
5. After signing in with the new account, tap **Profile → Unlock Pro Features** (the orange upgrade card).
6. The **paywall screen** opens. It lists Pro and Premium tiers with App Store prices.
7. Tap **Start Pro** or **Start Premium**. StoreKit presents the standard Apple payment sheet — no credit-card entry, no external link.
8. Complete the purchase with your **Sandbox Apple ID**. The subscription activates immediately via RevenueCat.
9. Return to **Profile**. You will now see **"Manage in App Store"** (not "Manage Billing"), confirming that IAP subscribers are directed to Apple's subscription management, not the Stripe portal.

---

### Sandbox Apple ID Credentials

Use these credentials at the StoreKit payment sheet (step 7 above):

- **Sandbox Apple ID:** [FILL IN — create at appstoreconnect.apple.com → Users and Access → Sandbox Testers]
- **Password:** [FILL IN]
- **Sandbox tier pre-configured:** Pro Monthly

*Sandbox purchases do not charge a real card and reset automatically.*

---

### Notes on the "Manage Billing" Button

- The **"Manage Billing"** row is only visible when the signed-in user has an active **Stripe (web) subscription** and **no** active StoreKit / RevenueCat entitlement.
- Users with an active IAP subscription see **"Manage in App Store"** instead.
- Free-plan users see neither button — they see the **paywall upgrade card**.
- The demo account above has a web subscription so both paths can be reviewed. Sign out and use a Sandbox Apple ID to reach the IAP path (steps 4–9 above).

---

### Contact

If you have any trouble with the test credentials or need a live walkthrough, please contact us at **sstec@stecstats.com** and we will respond within one business day.
