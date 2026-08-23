# App Store Review Reply — Guideline 3.1.1 (Billing Link)

> **How to use:** Copy the text under "Reply Text" verbatim into the App Store Connect
> review reply field. Before submitting, run through every step in
> [`SUBMISSION-CHECKLIST.md`](SUBMISSION-CHECKLIST.md) — especially verifying that the
> demo-account credentials in `review-notes.md` are current and tested.

---

## Reply Text

Thank you for your review. We'd like to clarify the "Manage Billing" button that appeared in the Profile screen.

**1. New in-app subscriptions use StoreKit / RevenueCat IAP exclusively.**

All subscriptions purchased inside the iOS app go through StoreKit via RevenueCat. The paywall (reachable from Profile → Unlock Pro Features) presents only IAP products; no credit-card form or external payment link is shown during the purchase flow. We have included step-by-step IAP test instructions and sandbox credentials in the App Review Information field so you can verify this directly.

**2. The "Manage Billing" link is shown only to existing web subscribers — not to IAP subscribers.**

StecStats is a cross-platform service: coaches can also subscribe at stecstats.com before downloading the app. For users whose active subscription was purchased on the web (via Stripe), the Profile screen shows a "Manage Billing" row that opens the Stripe customer portal at stecstats.com/billing. This row is rendered only when the app detects no active RevenueCat / StoreKit entitlement (`rcPlan === null`). Users with an active IAP subscription see "Manage in App Store" instead, which deep-links to `itms-apps://apps.apple.com/account/subscriptions`. The two paths are mutually exclusive.

This behaviour is explicitly permitted by App Store Review Guideline **3.1.3(b) — Multiplatform Services**: apps may allow existing web subscribers to access content or manage their subscription without routing through IAP.

**3. The app targets the US storefront, where linking to an external payment method is permitted.**

Following the court order in Epic Games, Inc. v. Apple Inc., US-storefront apps may include a link to an external website for purchases. The "Manage Billing" link falls within this ruling in addition to being covered by 3.1.3(b).

We believe the app fully complies with guidelines 3.1.1 and 3.1.3(b). Please let us know if you need any additional information or a live demo call.

---

## Summary of the Billing-Button Logic (for reference)

| User's active subscription source | Button label shown        | Destination                                      |
|-----------------------------------|---------------------------|--------------------------------------------------|
| StoreKit / RevenueCat (IAP)       | "Manage in App Store"     | `itms-apps://apps.apple.com/account/subscriptions` |
| Stripe / web                      | "Manage Billing"          | `https://stecstats.com/billing`                  |
| None (free plan)                  | Button not shown — paywall card shown instead | — |

Source: `artifacts/hoops-mobile/app/(tabs)/profile.tsx` — the `rcPlan` branch in the
"Manage Billing" `onPress` handler.
