# RevenueCat Annual Product Setup

The paywall UI (`app/paywall.tsx`) already supports the annual/monthly toggle and savings badge.
The toggle only appears when RevenueCat returns a package with `packageType === '$rc_annual'`
in the **default** offering. Follow the steps below to unlock it.

---

## 1 — Apple App Store Connect

1. Sign in → **My Apps → Hoops Stats Coach**
2. Navigate to **Monetization → Subscriptions**
3. Open the existing subscription group (e.g. *Hoops Stats Pro*)
4. Click **+** to add a new subscription product
   | Field | Value |
   |---|---|
   | Reference Name | Pro Annual |
   | Product ID | `com.hoopsstats.coach.pro_annual` |
   | Duration | 1 Year |
   | Price | **$59.99 / yr** (Tier 60) |
5. Under **Localizations**, add an English description:
   > *Full Pro access — live streaming, highlight reels, career stats — billed annually.*
6. Set **Free Trial** to **14 days** (matches the monthly product)
7. Submit for review (or mark "Ready to Submit" if the app is already approved)

---

## 2 — Google Play Console

1. Sign in → **Hoops Stats Coach → Monetize → Products → Subscriptions**
2. Click **Create subscription**
   | Field | Value |
   |---|---|
   | Product ID | `com.hoopsstats.coach.pro_annual` |
   | Name | Pro Annual |
3. Add a **Base plan**:
   | Field | Value |
   |---|---|
   | Base plan ID | `pro-annual` |
   | Billing period | Annually |
   | Price | **$59.99 / yr** |
4. Add an **offer** for the free trial:
   - Offer ID: `pro-annual-trial`
   - Eligibility: New subscribers only
   - Phase 1: Free trial — **14 days**
   - Phase 2: Regular billing at $59.99/yr
5. Activate the base plan and offer

---

## 3 — RevenueCat Dashboard

1. Sign in → **Projects → Hoops Stats Coach**
2. Go to **Products** and add both new store products:
   - App Store: `com.hoopsstats.coach.pro_annual`
   - Play Store: `com.hoopsstats.coach.pro_annual`
3. Go to **Offerings → default**
4. Click **+ Add package** → choose type **Annual** (identifier: `$rc_annual`)
5. Attach both new store products to this package
6. Verify the offering now has **two packages**: Monthly (`$rc_monthly`) and Annual (`$rc_annual`)
7. Confirm the **Pro** entitlement is attached to the annual product (same entitlement used by monthly)

---

## 4 — Verify in the App

Once RevenueCat propagates the updated offering (usually < 1 minute):

- Open the paywall — the **Monthly / Annual** toggle should appear above the PRO card
- The toggle defaults to **Annual** and the PRO card shows **$59.99 / year**
- The **Annual** button shows a green **"Save 37%"** badge (calculated from $9.99 × 12 vs $59.99)
- Tapping **Start Free Trial** on the Annual option initiates the `$rc_annual` purchase flow
- Completing the purchase grants the same **Pro** entitlement as the monthly plan

---

## Savings badge math

The badge is calculated automatically in the app:

```
saved = round((1 − annualPrice / (monthlyPrice × 12)) × 100)
      = round((1 − 59.99 / (9.99 × 12)) × 100)
      = round((1 − 59.99 / 119.88) × 100)
      ≈ 50%   ← at $59.99; adjust price to match stecstats.com positioning
```

To target ~30% savings, set the annual price to **$83.99**; for ~37% use **$75.49**.
The badge text updates automatically — no code change needed.
