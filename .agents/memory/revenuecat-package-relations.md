---
name: RevenueCat package relations
description: How the connected RevenueCat SDK shapes package-product responses.
---

RevenueCat package-product list responses contain relation objects whose product resource is nested under `product`; the relation's own `id` is not the product ID.

**Why:** Treating the relation as a product produced `undefined` IDs and made a live detach request fail with a nullable-parameter error.

**How to apply:** For package inspection or repair, read `relation.product.id` and `relation.product.store_identifier`, with a direct-field fallback only for SDK compatibility. Filter invalid IDs before mutation.