/**
 * Fixes the App Store Pro Monthly product store_identifier.
 * RevenueCat won't update store_identifier directly, so we:
 * 1. Rename the old "Pro Monthly" App Store product to "Pro Monthly (Legacy)"
 * 2. Create a new App Store product with the correct store_identifier
 * 3. Attach new product to $rc_monthly and pro entitlement
 * 4. Detach old product from $rc_monthly
 */
import { getUncachableRevenueCatClient } from "./revenueCatClient";
import {
  listProducts,
  createProduct,
  updateProduct,
  listEntitlements,
  attachProductsToEntitlement,
  listOfferings,
  listPackages,
  getProductsFromPackage,
  attachProductsToPackage,
  detachProductsFromPackage,
} from "@replit/revenuecat-sdk";

const PROJECT_ID = process.env.REVENUECAT_PROJECT_ID!;
const CORRECT_MONTHLY_STORE_ID = "com.stecapps.stecstats.pro.monthly";
const OLD_APP_STORE_PRO_MONTHLY_ID = "proda60d41261c"; // App Store Pro Monthly with wrong store_id

async function main() {
  const client = await getUncachableRevenueCatClient();

  // 1. Rename old product to "(Legacy)" so we can reuse the display name
  console.log("Renaming old App Store Pro Monthly to 'Pro Monthly (Legacy)'...");
  const { error: renameErr } = await updateProduct({
    client,
    path: { project_id: PROJECT_ID, product_id: OLD_APP_STORE_PRO_MONTHLY_ID },
    body: { display_name: "Pro Monthly (Legacy)" } as any,
  });
  if (renameErr) {
    console.warn("Could not rename (may not matter):", JSON.stringify(renameErr));
  } else {
    console.log("Renamed old product to 'Pro Monthly (Legacy)'");
  }

  // 2. Find the App Store app ID
  const { data: productsData } = await listProducts({
    client, path: { project_id: PROJECT_ID }, query: { limit: 100 },
  });
  const appStoreProducts = productsData?.items?.filter(p =>
    p.store_identifier?.startsWith("com.") && !p.store_identifier?.includes(":")
  ) ?? [];
  console.log("Current App Store products:", appStoreProducts.map(p => `${p.display_name}=${p.store_identifier}`));

  // Check if correct product already exists
  const existing = productsData?.items?.find(p => p.store_identifier === CORRECT_MONTHLY_STORE_ID);
  let correctProduct = existing;

  if (!existing) {
    // Get app_store app ID from the old product
    const oldProduct = productsData?.items?.find(p => p.id === OLD_APP_STORE_PRO_MONTHLY_ID);
    if (!oldProduct) throw new Error("Old App Store Pro Monthly not found");
    const appStoreAppId = oldProduct.app_id;

    console.log(`\nCreating new App Store Pro Monthly with correct store_id...`);
    const { data: newProduct, error: createErr } = await createProduct({
      client,
      path: { project_id: PROJECT_ID },
      body: {
        store_identifier: CORRECT_MONTHLY_STORE_ID,
        app_id: appStoreAppId,
        type: "subscription",
        display_name: "Pro Monthly",
      },
    });
    if (createErr) throw new Error(`Failed to create new product: ${JSON.stringify(createErr)}`);
    console.log(`Created new App Store Pro Monthly: ${newProduct.id}`);
    correctProduct = newProduct;
  } else {
    console.log(`Correct monthly product already exists: ${existing.id}`);
  }

  if (!correctProduct) throw new Error("Could not obtain correct monthly product");

  // 3. Attach new product to pro entitlement
  const { data: entData } = await listEntitlements({
    client, path: { project_id: PROJECT_ID }, query: { limit: 20 },
  });
  const proEntitlement = entData?.items?.find(e => e.lookup_key === "pro");
  if (!proEntitlement) throw new Error("Pro entitlement not found");

  const { error: entAttErr } = await attachProductsToEntitlement({
    client,
    path: { project_id: PROJECT_ID, entitlement_id: proEntitlement.id },
    body: { product_ids: [correctProduct.id] },
  });
  if (entAttErr) {
    const t = (entAttErr as any)?.type ?? "";
    if (t === "unprocessable_entity_error") {
      console.log("Already attached to pro entitlement");
    } else {
      console.warn("Entitlement attach error:", JSON.stringify(entAttErr));
    }
  } else {
    console.log("Attached new product to pro entitlement");
  }

  // 4. Fix $rc_monthly package
  const { data: offeringsData } = await listOfferings({
    client, path: { project_id: PROJECT_ID }, query: { limit: 20 },
  });
  const defaultOffering = offeringsData?.items?.find(o => o.lookup_key === "default");
  if (!defaultOffering) throw new Error("Default offering not found");

  const { data: packagesData } = await listPackages({
    client,
    path: { project_id: PROJECT_ID, offering_id: defaultOffering.id },
    query: { limit: 20 },
  });
  const monthlyPkg = packagesData?.items?.find(p => p.lookup_key === "$rc_monthly");
  if (!monthlyPkg) throw new Error("$rc_monthly package not found");

  const { data: monthlyPkgProds } = await getProductsFromPackage({
    client,
    path: { project_id: PROJECT_ID, package_id: monthlyPkg.id },
    query: { limit: 20 },
  });
  const currentIds = (monthlyPkgProds?.items ?? []).map((item: any) => item.product?.id).filter(Boolean);
  console.log("\n$rc_monthly current product IDs:", currentIds);

  // Detach old product if present
  if (currentIds.includes(OLD_APP_STORE_PRO_MONTHLY_ID)) {
    const { error: detErr } = await detachProductsFromPackage({
      client,
      path: { project_id: PROJECT_ID, package_id: monthlyPkg.id },
      body: { product_ids: [OLD_APP_STORE_PRO_MONTHLY_ID] },
    });
    if (detErr) {
      console.warn("Could not detach old monthly:", JSON.stringify(detErr));
    } else {
      console.log("Detached old App Store Pro Monthly from $rc_monthly");
    }
  }

  // Attach new product
  if (!currentIds.includes(correctProduct.id)) {
    const { error: attErr } = await attachProductsToPackage({
      client,
      path: { project_id: PROJECT_ID, package_id: monthlyPkg.id },
      body: { products: [{ product_id: correctProduct.id, eligibility_criteria: "all" }] },
    });
    if (attErr) {
      const t = (attErr as any)?.type ?? "";
      if (t === "unprocessable_entity_error") {
        console.log("New monthly already on $rc_monthly");
      } else {
        console.error("Failed to attach new monthly to $rc_monthly:", JSON.stringify(attErr));
      }
    } else {
      console.log("✅ Attached correct App Store Pro Monthly to $rc_monthly");
    }
  } else {
    console.log("Correct monthly already on $rc_monthly");
  }

  // Final verification
  const { data: finalProds } = await getProductsFromPackage({
    client,
    path: { project_id: PROJECT_ID, package_id: monthlyPkg.id },
    query: { limit: 20 },
  });
  console.log("\n=== $rc_monthly FINAL ===");
  for (const item of finalProds?.items ?? []) {
    const p = (item as any).product;
    console.log(`  ${p?.display_name} — store_id: ${p?.store_identifier} — app: ${p?.app_id}`);
  }
}

main().catch(console.error);
