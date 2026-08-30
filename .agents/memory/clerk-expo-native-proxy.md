---
name: Clerk Expo native proxy support
description: Why native Release builds require the current Clerk Expo package when a custom-domain proxy is used.
---

Native Clerk clients that must use `proxyUrl` require `@clerk/expo` v4 or later. The deprecated `@clerk/clerk-expo` package and older `@clerk/expo` releases accepted the React prop but omitted it when constructing the native Clerk instance, causing iOS to contact the publishable key's custom hostname directly.

**Why:** A physical Release build completed Apple's account sheet but never signed in. Xcode showed `NSURLErrorDomain -1003` requests to the unresolved custom Clerk hostname even though the reachable production proxy URL was embedded in the bundle.

**How to apply:** Keep the provider and general hooks on `@clerk/expo` v4+. Existing imperative `useSignIn`/`useSignUp` code can temporarily import from `@clerk/expo/legacy`. Prove transport on-device by checking for the safe `Transport: proxy` diagnostic and requests to the application proxy path.