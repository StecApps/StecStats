# Production iOS RevenueCat Configuration

This is the single release configuration for the StecStats production iOS app.
The bundle ID and App Store product IDs are intentionally different legacy
identifiers; do not rename them during App Review.

| Setting | Production value |
|---|---|
| App name | StecStats |
| iOS bundle ID | `com.hoopsstats.coach` |
| RevenueCat iOS SDK key | Production public key with `appl_` prefix |
| RevenueCat current offering | `default` |
| Pro entitlement | `pro` |
| Monthly package | `$rc_monthly` |
| Annual package | `$rc_annual` |
| Monthly App Store product | `StecStats` |
| Annual App Store product | `StecStatsAnnual` |

## 1 — App Store Connect

1. Open the app whose bundle ID is `com.hoopsstats.coach`.
2. Under **Monetization → Subscriptions**, confirm both products are in the same
   subscription group:
   - `StecStats` — 1 month, $9.99, 14-day trial
   - `StecStatsAnnual` — 1 year, $59.99, 14-day trial
3. Confirm pricing, localization, tax/category details, review screenshots,
   storefront availability, and Apple agreements are complete.
4. Attach both subscriptions to the app version and submit them with the binary.

## 2 — RevenueCat

1. Select the production iOS app for bundle ID `com.hoopsstats.coach`.
2. Confirm both App Store product IDs above are imported.
3. Confirm both products grant entitlement `pro`.
4. Open offering `default` and mark it **Current**.
5. Assign:
   - `$rc_monthly` → `StecStats`
   - `$rc_annual` → `StecStatsAnnual`
6. Do not attach either product to the unreleased `premium` entitlement.

## 3 — Production build

The production profile must set `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY` to the
RevenueCat public iOS SDK key (`appl_…`). The app logs only the selected key
path, current offering identifier, package identifiers, and product identifiers;
it never logs the key itself.

## 4 — Final physical-device/TestFlight smoke test

1. Install the exact submitted TestFlight build on a physical iOS device.
2. Sign in with a free account and open **Profile → Unlock Pro Features**.
3. Confirm Monthly and Annual appear and both prices come from StoreKit.
4. Select each period and confirm **Start Free Trial** reaches Apple’s purchase
   sheet.
5. Complete one Sandbox purchase and confirm the `pro` entitlement activates.
6. Confirm **Restore purchases** restores the entitlement.

If loading fails, the paywall now distinguishes a network/App Store failure,
missing current offering, empty StoreKit response, missing package assignment,
wrong current offering, and wrong product assignment. Use that message with the
table above rather than treating every failure as an empty package list.