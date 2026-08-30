/**
 * Fixes the RevenueCat configuration:
 * 1. Updates the App Store app bundle_id to com.hoopsstats.coach (was com.hoopsstats.app)
 * 2. Creates App Store products with the correct store identifiers from App Store Connect
 * 3. Creates a test-store annual product (P1Y)
 * 4. Reconfigures $rc_monthly to point to the correct Pro monthly products
 * 5. Reconfigures $rc_annual to be Pro Annual (not Premium Monthly)
 * 6. Attaches all products to the pro entitlement
 */
import { getUncachableRevenueCatClient } from "./revenueCatClient";
import {
  listApps,
  updateApp,
  updateProduct,
  listProducts,
  createProduct,
  listEntitlements,
  attachProductsToEntitlement,
  detachProductsFromEntitlement,
  listOfferings,
  listPackages,
  updatePackage,
  attachProductsToPackage,
  detachProductsFromPackage,
  getProductsFromPackage,
  getProductsFromEntitlement,
  type App,
  type Product,
} from "@replit/revenuecat-sdk";

const PROJECT_ID = process.env.REVENUECAT_PROJECT_ID!;
// Correct App Store Connect product identifiers
const APP_STORE_PRO_MONTHLY_ID  = "StecStats";
const APP_STORE_PRO_ANNUAL_ID   = "StecStatsAnnual";
const TEST_STORE_PRO_ANNUAL_ID  = "pro_annual"; // test store internal ID
const CORRECT_BUNDLE_ID         = "com.hoopsstats.coach";

async function main() {
  const client = await getUncachableRevenueCatClient();

  // ── 1. Apps ───────────────────────────────────────────────────────────────
  const { data: appsData, error: appsErr } = await listApps({
    client, path: { project_id: PROJECT_ID }, query: { limit: 20 },
  });
  if (appsErr || !appsData) throw new Error("Failed to list apps");

  const testStoreApp = appsData.items.find((a: App) => a.type === "test_store");
  const appStoreApp  = appsData.items.find((a: App) => a.type === "app_store");
  if (!testStoreApp || !appStoreApp) throw new Error("Missing test_store or app_store app");

  // Update App Store bundle_id if wrong
  const currentBundleId = (appStoreApp as any).app_store?.bundle_id ?? (appStoreApp as any).bundle_id;
  if (currentBundleId !== CORRECT_BUNDLE_ID) {
    console.log(`Updating App Store bundle_id: ${currentBundleId} → ${CORRECT_BUNDLE_ID}`);
    const { error: updateErr } = await updateApp({
      client,
      path: { project_id: PROJECT_ID, app_id: appStoreApp.id },
      body: { name: "Hoops Stats iOS", app_store: { bundle_id: CORRECT_BUNDLE_ID } } as any,
    });
    if (updateErr) {
      console.warn("Could not update bundle_id (may not be supported):", JSON.stringify(updateErr));
    } else {
      console.log("Updated App Store bundle_id to", CORRECT_BUNDLE_ID);
    }
  } else {
    console.log("App Store bundle_id already correct:", CORRECT_BUNDLE_ID);
  }

  // ── 2. Products ───────────────────────────────────────────────────────────
  const { data: productsData } = await listProducts({
    client, path: { project_id: PROJECT_ID }, query: { limit: 100 },
  });
  const allProducts: Product[] = productsData?.items ?? [];

  const findProduct = (appId: string, storeId: string) =>
    allProducts.find(p => p.app_id === appId && p.store_identifier === storeId);

  const ensureProduct = async (
    app: App,
    label: string,
    storeIdentifier: string,
    displayName: string,
    isTestStore: boolean,
    duration?: string,
  ): Promise<Product> => {
    // First check: already exists with correct store_identifier
    const existing = findProduct(app.id, storeIdentifier);
    if (existing) {
      console.log(`${label} already exists with correct store_id: ${existing.id}`);
      return existing;
    }

    // Test Store identifiers can be updated. App Store identifiers are immutable,
    // so create a new RevenueCat product when App Store Connect uses a different ID.
    const existingByName = allProducts.find(
      p => p.app_id === app.id && p.display_name === displayName,
    );
    if (existingByName && isTestStore) {
      console.log(`${label} exists (id: ${existingByName.id}) with wrong store_id '${existingByName.store_identifier}', updating to '${storeIdentifier}'...`);
      const { data: updated, error: updateErr } = await updateProduct({
        client,
        path: { project_id: PROJECT_ID, product_id: existingByName.id },
        body: { store_identifier: storeIdentifier } as any,
      });
      if (updateErr) {
        console.warn(`Could not update store_identifier for ${label}:`, JSON.stringify(updateErr));
        console.log("Continuing with existing product as-is");
        return existingByName;
      }
      console.log(`Updated ${label} store_identifier to ${storeIdentifier}`);
      return updated ?? existingByName;
    }
    if (existingByName) {
      const legacyDisplayName = `${displayName} (Legacy Reference ID)`;
      console.log(
        `${label} has a legacy store_id '${existingByName.store_identifier}'; renaming it to '${legacyDisplayName}' before creating '${storeIdentifier}'...`,
      );
      const { error: renameError } = await updateProduct({
        client,
        path: { project_id: PROJECT_ID, product_id: existingByName.id },
        body: { display_name: legacyDisplayName },
      });
      if (renameError) {
        throw new Error(
          `Failed to rename legacy ${label}: ${JSON.stringify(renameError)}`,
        );
      }
    }

    // Create new product
    const body: any = {
      store_identifier: storeIdentifier,
      app_id: app.id,
      type: "subscription",
      display_name: displayName,
    };
    if (isTestStore && duration) {
      body.subscription = { duration };
      body.title = displayName;
    }
    const { data, error } = await createProduct({
      client, path: { project_id: PROJECT_ID }, body,
    });
    if (error) throw new Error(`Failed to create ${label}: ${JSON.stringify(error)}`);
    console.log(`Created ${label}: ${data.id}`);
    return data;
  };

  // App Store: correct monthly and annual products
  const appStoreMonthly = await ensureProduct(appStoreApp, "AppStore Pro Monthly", APP_STORE_PRO_MONTHLY_ID, "Pro Monthly", false);
  const appStoreAnnual  = await ensureProduct(appStoreApp, "AppStore Pro Annual",  APP_STORE_PRO_ANNUAL_ID,  "Pro Annual",  false);

  // Test Store: annual product (P1Y)
  const testStoreAnnual = await ensureProduct(testStoreApp, "TestStore Pro Annual", TEST_STORE_PRO_ANNUAL_ID, "Pro Annual", true, "P1Y");

  // Add test store price for annual ($59.99/year)
  console.log("Setting test store price for annual product...");
  const { error: priceErr } = await client.post<any>({
    url: "/projects/{project_id}/products/{product_id}/test_store_prices",
    path: { project_id: PROJECT_ID, product_id: testStoreAnnual.id },
    body: { prices: [{ amount_micros: 59990000, currency: "USD" }] },
  });
  if (priceErr) {
    const errType = (priceErr as any)?.type ?? "";
    if (errType === "resource_already_exists") {
      console.log("Test store annual price already set");
    } else {
      console.warn("Could not set test store annual price:", JSON.stringify(priceErr));
    }
  } else {
    console.log("Set test store annual price: $59.99");
  }

  // ── 3. Entitlements ───────────────────────────────────────────────────────
  const { data: entData } = await listEntitlements({
    client, path: { project_id: PROJECT_ID }, query: { limit: 20 },
  });
  const proEntitlement = entData?.items?.find(e => e.lookup_key === "pro");
  if (!proEntitlement) throw new Error("Pro entitlement not found");

  // Get currently attached products
  const { data: entProds } = await getProductsFromEntitlement({
    client, path: { project_id: PROJECT_ID, entitlement_id: proEntitlement.id }, query: { limit: 50 },
  });
  const attachedToEntitlement = new Set(entProds?.items?.map((p: any) => p.id) ?? []);

  // Attach new App Store products to pro entitlement (if not already attached)
  const toAttachToEnt = [appStoreMonthly.id, appStoreAnnual.id, testStoreAnnual.id]
    .filter(id => !attachedToEntitlement.has(id));

  if (toAttachToEnt.length > 0) {
    const { error: attErr } = await attachProductsToEntitlement({
      client,
      path: { project_id: PROJECT_ID, entitlement_id: proEntitlement.id },
      body: { product_ids: toAttachToEnt },
    });
    if (attErr) {
      const errType = (attErr as any)?.type ?? "";
      if (errType === "unprocessable_entity_error") {
        console.log("Products already attached to pro entitlement");
      } else {
        console.warn("Failed to attach to pro entitlement:", JSON.stringify(attErr));
      }
    } else {
      console.log("Attached new products to pro entitlement:", toAttachToEnt);
    }
  } else {
    console.log("New products already attached to pro entitlement");
  }

  // ── 4. Packages ──────────────────────────────────────────────────────────
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
  const annualPkg  = packagesData?.items?.find(p => p.lookup_key === "$rc_annual");
  if (!monthlyPkg) throw new Error("$rc_monthly package not found");
  if (!annualPkg)  throw new Error("$rc_annual package not found");

  // Helper: get products currently on a package
  const getPackageProductIds = async (pkgId: string): Promise<string[]> => {
    const { data } = await getProductsFromPackage({
      client,
      path: { project_id: PROJECT_ID, package_id: pkgId },
      query: { limit: 50 },
    });
    return data?.items
      ?.map((relation: any) => relation.product?.id ?? relation.id)
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0) ?? [];
  };

  // Fix $rc_monthly — ensure correct App Store monthly product is attached
  const monthlyAttached = await getPackageProductIds(monthlyPkg.id);
  console.log("\n$rc_monthly currently has product ids:", monthlyAttached);

  const staleMonthlyAppStoreIds = monthlyAttached.filter((id) =>
    id !== appStoreMonthly.id &&
    allProducts.some((product) => product.id === id && product.app_id === appStoreApp.id)
  );
  if (staleMonthlyAppStoreIds.length > 0) {
    const { error: detachMonthlyError } = await detachProductsFromPackage({
      client,
      path: { project_id: PROJECT_ID, package_id: monthlyPkg.id },
      body: { product_ids: staleMonthlyAppStoreIds },
    });
    if (detachMonthlyError) {
      console.warn(
        "Could not detach legacy App Store products from $rc_monthly:",
        JSON.stringify(detachMonthlyError),
      );
    } else {
      console.log(
        "Detached legacy App Store products from $rc_monthly:",
        staleMonthlyAppStoreIds,
      );
    }
  }

  if (!monthlyAttached.includes(appStoreMonthly.id)) {
    const { error } = await attachProductsToPackage({
      client,
      path: { project_id: PROJECT_ID, package_id: monthlyPkg.id },
      body: { products: [{ product_id: appStoreMonthly.id, eligibility_criteria: "all" }] },
    });
    if (error) {
      const errType = (error as any)?.type ?? "";
      if (errType === "unprocessable_entity_error") {
        console.log("App Store monthly already on $rc_monthly (unprocessable)");
      } else {
        console.warn("Failed to attach App Store monthly to $rc_monthly:", JSON.stringify(error));
      }
    } else {
      console.log("Attached App Store Pro Monthly to $rc_monthly");
    }
  } else {
    console.log("App Store Pro Monthly already on $rc_monthly");
  }

  // Fix $rc_annual — remove non-annual products and attach any missing annual products.
  const annualAttached = await getPackageProductIds(annualPkg.id);
  console.log("\n$rc_annual currently has product ids:", annualAttached);

  const expectedAnnualIds = new Set([appStoreAnnual.id, testStoreAnnual.id]);
  const annualIdsToDetach = annualAttached.filter((id) => !expectedAnnualIds.has(id));
  if (annualIdsToDetach.length > 0) {
    const { error: detErr } = await detachProductsFromPackage({
      client,
      path: { project_id: PROJECT_ID, package_id: annualPkg.id },
      body: { product_ids: annualIdsToDetach },
    });
    if (detErr) {
      console.warn("Could not detach old products from $rc_annual:", JSON.stringify(detErr));
    } else {
      console.log("Detached old products from $rc_annual:", annualIdsToDetach);
    }
  }

  const annualProductsToAttach = [
    { product_id: appStoreAnnual.id, eligibility_criteria: "all" as const },
    { product_id: testStoreAnnual.id, eligibility_criteria: "all" as const },
  ].filter(({ product_id }) => !annualAttached.includes(product_id));
  if (annualProductsToAttach.length > 0) {
    const { error: attAnnErr } = await attachProductsToPackage({
      client,
      path: { project_id: PROJECT_ID, package_id: annualPkg.id },
      body: { products: annualProductsToAttach },
    });
    if (attAnnErr) {
      console.warn("Failed to attach annual products to $rc_annual:", JSON.stringify(attAnnErr));
    } else {
      console.log("Attached missing Pro Annual products to $rc_annual");
    }
  } else {
    console.log("Pro Annual products already on $rc_annual");
  }

  // Keep the dashboard label aligned with the package's annual Pro products.
  if (annualPkg.display_name !== "Pro Annual") {
    const { error: updatePackageError } = await updatePackage({
      client,
      path: { project_id: PROJECT_ID, package_id: annualPkg.id },
      body: { display_name: "Pro Annual" },
    });
    if (updatePackageError) {
      console.warn(
        "Could not rename $rc_annual to Pro Annual:",
        JSON.stringify(updatePackageError),
      );
    } else {
      console.log("Renamed $rc_annual package to Pro Annual");
    }
  }

  console.log("\nDone! Running final inspection...");

  // Final state
  const monthlyFinal = await getPackageProductIds(monthlyPkg.id);
  const annualFinal  = await getPackageProductIds(annualPkg.id);
  console.log("\n=== FINAL STATE ===");
  console.log("$rc_monthly product IDs:", monthlyFinal);
  console.log("$rc_annual product IDs:", annualFinal);
  console.log("\nApp Store Pro Monthly product ID:", appStoreMonthly.id, "store_id:", APP_STORE_PRO_MONTHLY_ID);
  console.log("App Store Pro Annual  product ID:", appStoreAnnual.id,  "store_id:", APP_STORE_PRO_ANNUAL_ID);
  console.log("Test Store Pro Annual product ID:", testStoreAnnual.id, "store_id:", TEST_STORE_PRO_ANNUAL_ID);
}

main().catch(console.error);
