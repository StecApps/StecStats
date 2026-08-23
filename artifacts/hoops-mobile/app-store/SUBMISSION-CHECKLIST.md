# App Store Submission Checklist

Run through every item below before submitting a new build to App Store Connect.
Check off each step manually — do not skip credential verification even for minor version bumps.

---

## 1 — Update credentials in `review-notes.md`

- [ ] Open `artifacts/hoops-mobile/app-store/review-notes.md`.
- [ ] Replace **Demo Account → Email** `[FILL IN]` with the current reviewer email.
- [ ] Replace **Demo Account → Password** `[FILL IN]` with the current password.
- [ ] Replace **Sandbox Apple ID** `[FILL IN]` with the current sandbox tester email (from App Store Connect → Users and Access → Sandbox Testers).
- [ ] Replace **Sandbox Apple ID → Password** `[FILL IN]` with the current sandbox password.
- [ ] Commit the updated `review-notes.md` so the credentials are version-controlled with the build.

---

## 2 — Verify the demo account works end-to-end

- [ ] Launch the app on a physical device (or simulator).
- [ ] Sign in with the demo account credentials from step 1.
- [ ] Confirm the **Profile** tab shows **"Manage Billing"** (indicating a Stripe/web subscription is active).
- [ ] Sign out and sign back in to confirm the credentials are accepted without error.

---

## 3 — Verify the Sandbox IAP flow

- [ ] On a device signed into a **Sandbox Apple ID** (Settings → App Store → Sandbox Account), open the app.
- [ ] Create a fresh account (or sign in with a sandbox-linked account).
- [ ] Navigate to **Profile → Unlock Pro Features**.
- [ ] Confirm the paywall opens and lists Pro / Premium tiers with App Store prices.
- [ ] Tap **Start Pro** (or **Start Premium**) and confirm the StoreKit payment sheet appears — no credit-card form, no external link.
- [ ] Complete the Sandbox purchase and confirm the Profile screen switches to **"Manage in App Store"**.

---

## 4 — Paste review notes into App Store Connect

- [ ] Copy the full content of the **"Notes (paste into App Store Connect)"** section from `review-notes.md`.
- [ ] In App Store Connect, open the submission → **App Review Information → Notes**.
- [ ] Paste and save.
- [ ] Verify the notes display correctly (no raw Markdown artifacts).

---

## 5 — Paste the review reply (if responding to a prior rejection)

- [ ] If this submission is a response to a guideline rejection, open `review-reply-3.1.1.md`.
- [ ] Copy the **Reply Text** verbatim.
- [ ] Paste it into the App Store Connect review reply field before re-submitting.

---

## 6 — Final checks before submitting

- [ ] Build version and build number are incremented.
- [ ] All `[FILL IN]` placeholders in `review-notes.md` have been replaced — search the file for `[FILL IN]` to confirm zero matches.
- [ ] Contact email in `review-notes.md` (`sstec@stecstats.com`) is current and monitored.
- [ ] Submit the build.

---

*Keep this checklist and `review-notes.md` up to date after every password rotation or sandbox tester change.*
