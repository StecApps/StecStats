# App Review Information — Notes Field

> Paste the section below into **App Review Information → Notes** for the
> submitted build. Do not paste passwords, Sandbox Apple IDs, or other secrets
> into this file or source control.

---

## Notes (paste into App Store Connect)

### Review the in-app purchase

No demo account is required. Please use **Sign in with Apple** on the opening
screen:

1. Open StecStats and choose **Sign in with Apple**.
2. Complete the native Apple sign-in sheet. A new, free StecStats account is
   created automatically.
3. Open **Profile** and tap **Unlock Pro Features**.
4. The paywall shows the Pro subscription with Monthly and Annual options.
5. Tap **Start Free Trial**. The standard StoreKit purchase sheet is presented;
   StecStats does not open a web checkout or ask for credit-card details.
6. After purchase, return to Profile. The subscription-management action opens
   Apple Account subscription settings.
7. **Restore purchases** is available at the bottom of the paywall.

The submitted In-App Purchase products are:

- `com.stecapps.stecstats.pro.monthly`
- `com.stecapps.stecstats.pro.annualDeal`

### Account deletion

The app supports permanent account deletion:

1. Sign in, then open **Profile**.
2. Scroll to **Account** and tap **Delete Account**.
3. Confirm **Continue**, then confirm **Delete Account**.
4. The app permanently deletes the StecStats profile, teams, players, games,
   recordings, generated reels, saved media, linked YouTube credential, and
   sign-in identity.

Deleting a StecStats account does not cancel an Apple subscription. The
confirmation dialog directs users to Apple Account Settings (or Manage Billing
for a web subscription) to cancel first when needed.

### Contact

For review support, contact **sstec@stecstats.com**. We respond within one
business day.