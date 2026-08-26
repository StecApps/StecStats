# App Review Reply — Guideline 2.1 Login

> Replace `[NEW BUILD NUMBER]` only after uploading and selecting the corrected
> build in App Store Connect. Do not claim the physical-device check is complete
> until it has actually passed.

---

## Reply Text

Thank you for identifying the email verification issue in version 1.0
(build 36).

We found and corrected an iPad-specific verification-code handling bug. When
iPadOS autofill or paste delivered all six digits in one input event, the app
could attempt verification using the previous incomplete value and remain on
the login screen. Version 1.0 (build [NEW BUILD NUMBER]) now verifies the exact
six-digit value entered by autofill, paste, the Verify button, or the keyboard
Done action, and then activates the session and opens the app.

The previously supplied password `StecStatsReview123` is not an app credential.
StecStats does not use password authentication.

For the simplest review path, no demo account is required:

1. Open StecStats.
2. Tap **Sign in with Apple**.
3. Complete Apple’s native sign-in sheet. A new free StecStats account is
   created and the app opens automatically.
4. To review the in-app purchase, open
   **Profile → Unlock Pro Features → Start Free Trial**.

If email sign-in is preferred, enter the reviewer email listed in App Review
Information, tap **Continue**, and enter the fresh six-digit code delivered to
the reviewer-accessible inbox. No password is used.

We tested the corrected release build on a clean installation using six-digit
autofill/paste and manual entry before resubmitting.
