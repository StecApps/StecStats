# App Review Information — Notes Field

> Paste the section below into **App Review Information → Notes** for the
> submitted build. Do not paste passwords, Sandbox Apple IDs, or other secrets
> into this file or source control.

---

## Notes (paste into App Store Connect)


### Review sign-in

No paid account is required.

**Preferred path:** Open StecStats and choose **Sign in with Apple**. Complete
the native Apple sign-in sheet to create a new, free StecStats account.

**Free reviewer account:** If using the supplied reviewer account instead:

- **Email:** reviewer@stecstats.com
- **Sign-in method:** Enter the email address, tap **Continue**, then enter
  the 6-digit verification code sent to that inbox. No app password is used.
- **Account type:** Free (no subscription is pre-activated).
- **Email-code delivery:** `reviewer@stecstats.com` is the active Production
  Clerk email-code account for this submission. The review team monitors its
  inbox throughout review and can provide each newly generated code through
  the approved reviewer-access arrangement. If a code is not visible, request
  a new code from the sign-in screen; do not use a password or an earlier
  code.

### Review the in-app purchase

1. Install the current build on a **physical iOS device**.
2. Sign in with Apple, or sign in with the free reviewer account using its
   6-digit email code.
3. Tap the **Profile** tab.
4. Tap **Unlock Pro Features**.
5. The paywall lists the Pro Monthly and Pro Annual products above.
6. Choose Monthly or Annual, then tap **Start Free Trial**. StoreKit presents
   Apple’s standard payment sheet; StecStats does not open a web checkout or
   ask for credit-card details.
7. Complete the purchase with the Sandbox Apple ID. The Pro subscription
   activates via RevenueCat.
8. Return to **Profile** and confirm the Pro plan is active.
9. Open **Profile → Unlock Pro Features** again and tap **Restore purchases**.
   Confirm the restore result is shown.

### Account deletion

The app supports direct, permanent in-app account deletion:

1. Sign in, then open **Profile → Delete Account**.
2. Confirm **Continue**, then **Delete Account** in the final confirmation.
3. The app permanently deletes the StecStats profile, teams, players, games,
   recordings, highlights, saved media, and matching sign-in identity, then
   returns to the welcome screen.

Deleting a StecStats account does not cancel an Apple subscription. The final
confirmation directs users to Apple Account Settings to manage or cancel it.

Public account-deletion information page:
https://stecstats.com/account-deletion


### Required physical-device recording

Attach a current physical-device screen recording to App Review Information
(or provide a review-accessible link) before submitting. It must show:

1. Sign in with Apple or email-code sign-in with the free reviewer account.
2. Opening **Profile → Delete Account**.
3. Tapping **Continue**, then **Delete Account** in the final confirmation.
4. The app returning to the welcome screen after deletion.

### Contact

For review support, contact **support@stecstats.com**. We respond within one
business day.

### Step-by-Step: Account Deletion (Guideline 5.1.1)

1. Sign in with Apple (or create a new account).
2. Tap the **Profile** tab (bottom-right).
3. Scroll to the **Account** section and tap **Delete Account**.
4. The first confirmation explains that teams, players, game stats, saved videos, highlights, photos, YouTube connection, and the sign-in identity will be permanently deleted. It also explains that deleting the account does **not** cancel an Apple subscription.
5. If a subscription needs to be cancelled, tap **Manage in App Store** on that confirmation; otherwise tap **Continue**.
6. Tap **Delete Account** in the final confirmation. The app clears recoverable
   drafts and pending uploads from the device, signs out, and returns to the
   sign-in screen.

---

### Current submitted IAP products

The submitted iOS build includes these Pro subscriptions in the default
StoreKit / RevenueCat offering:

- App bundle ID: `com.hoopsstats.coach`
- RevenueCat current offering: `default`
- RevenueCat packages: `$rc_monthly` and `$rc_annual`
- RevenueCat entitlement granted by both products: `pro`

| Product | App Store product ID | Duration | Price | Introductory offer |
|---|---|---|---|---|
| Pro Monthly | `StecStats` | 1 month | $9.99/month | 14-day free trial |
| Pro Annual | `StecStatsAnnual` | 1 year | $59.99/year | 14-day free trial |

Premium is displayed as **Coming Soon** and is not a purchasable product in
this submission.
