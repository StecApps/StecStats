---
name: App Store product identifiers
description: Distinguishes App Store Connect reference names from StoreKit product IDs.
---

In App Store Connect, the Reference Name is not the StoreKit product identifier. RevenueCat must use the value in the Product ID column, even when the reference name looks like a bundle-style identifier.

**Why:** A subscription group showed bundle-like reference names but product IDs `StecStats` and `StecStatsAnnual`; using the reference names caused StoreKit to return no products.

**How to apply:** When configuring Apple subscriptions, copy the Product ID column exactly and verify it against the RevenueCat App Store product's `store_identifier`.