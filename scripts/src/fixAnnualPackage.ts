/**
 * Fixes $rc_annual package to point to Pro Annual products.
 * First logs the raw package product structure to find the correct field names.
 */
import { getUncachableRevenueCatClient } from "./revenueCatClient";
import {
  listOfferings,
  listPackages,
  getProductsFromPackage,
  attachProductsToPackage,
  detachProductsFromPackage,
} from "@replit/revenuecat-sdk";

const PROJECT_ID = process.env.REVENUECAT_PROJECT_ID!;

// IDs from the last inspection run
const APP_STORE_ANNUAL_PRODUCT_ID = "prodd2dd700635";
const TEST_STORE_ANNUAL_PRODUCT_ID = "prodc38dc1ad3a";

async function main() {
  const client = await getUncachableRevenueCatClient();

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

  const annualPkg = packagesData?.items?.find(p => p.lookup_key === "$rc_annual");
  const monthlyPkg = packagesData?.items?.find(p => p.lookup_key === "$rc_monthly");
  if (!annualPkg) throw new Error("$rc_annual package not found");
  if (!monthlyPkg) throw new Error("$rc_monthly package not found");

  // Log raw structure to see field names
  const { data: annualPkgProds } = await getProductsFromPackage({
    client,
    path: { project_id: PROJECT_ID, package_id: annualPkg.id },
    query: { limit: 20 },
  });
  console.log("=== $rc_annual raw products ===");
  console.log(JSON.stringify(annualPkgProds?.items?.[0], null, 2));
  
  const { data: monthlyPkgProds } = await getProductsFromPackage({
    client,
    path: { project_id: PROJECT_ID, package_id: monthlyPkg.id },
    query: { limit: 20 },
  });
  console.log("=== $rc_monthly raw products ===");
  console.log(JSON.stringify(monthlyPkgProds?.items?.[0], null, 2));

  // Extract product IDs using correct field — try both 'id' and 'product_id'
  const getIds = (items: any[]) =>
    items?.map(item => item.id ?? item.product_id ?? item.product?.id).filter(Boolean) ?? [];

  const annualCurrentIds = getIds(annualPkgProds?.items ?? []);
  console.log("\n$rc_annual current product IDs:", annualCurrentIds);

  // Detach old products if any
  if (annualCurrentIds.length > 0) {
    console.log("Detaching old products from $rc_annual...");
    const { error } = await detachProductsFromPackage({
      client,
      path: { project_id: PROJECT_ID, package_id: annualPkg.id },
      body: { product_ids: annualCurrentIds },
    });
    if (error) {
      console.warn("Detach error:", JSON.stringify(error));
    } else {
      console.log("Detached:", annualCurrentIds);
    }
  }

  // Attach the annual Pro products
  console.log("\nAttaching annual Pro products to $rc_annual...");
  const { error: attErr } = await attachProductsToPackage({
    client,
    path: { project_id: PROJECT_ID, package_id: annualPkg.id },
    body: {
      products: [
        { product_id: APP_STORE_ANNUAL_PRODUCT_ID,  eligibility_criteria: "all" },
        { product_id: TEST_STORE_ANNUAL_PRODUCT_ID, eligibility_criteria: "all" },
      ],
    },
  });
  if (attErr) {
    console.error("Failed to attach annual products:", JSON.stringify(attErr));
  } else {
    console.log("✅ Attached App Store + Test Store annual products to $rc_annual");
  }

  // Verify
  const { data: afterAnnual } = await getProductsFromPackage({
    client,
    path: { project_id: PROJECT_ID, package_id: annualPkg.id },
    query: { limit: 20 },
  });
  console.log("\n=== $rc_annual AFTER ===");
  for (const item of afterAnnual?.items ?? []) {
    console.log(" ", JSON.stringify(item));
  }
}

main().catch(console.error);
