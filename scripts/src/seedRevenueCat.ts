import { getUncachableRevenueCatClient } from "./revenueCatClient";

import {
  listProjects,
  createProject,
  listApps,
  createApp,
  listAppPublicApiKeys,
  listProducts,
  createProduct,
  listEntitlements,
  createEntitlement,
  attachProductsToEntitlement,
  listOfferings,
  createOffering,
  updateOffering,
  listPackages,
  createPackages,
  attachProductsToPackage,
  type App,
  type Product,
  type Project,
  type Entitlement,
  type Offering,
  type Package,
  type CreateProductData,
  type Duration,
} from "@replit/revenuecat-sdk";

const PROJECT_NAME = "Hoops Stats";

// ── Pro plan ────────────────────────────────────────────────────────────────
const PRO_PRODUCT_IDENTIFIER = "hoops_pro_monthly";
const PLAY_STORE_PRO_PRODUCT_IDENTIFIER = "hoops_pro_monthly:monthly";
const PRO_PRODUCT_DISPLAY_NAME = "Pro Monthly";
const PRO_PRODUCT_USER_FACING_TITLE = "Pro Monthly";
const PRO_PRODUCT_DURATION = "P1M";
const PRO_ENTITLEMENT_IDENTIFIER = "pro";
const PRO_ENTITLEMENT_DISPLAY_NAME = "Pro Access";
const PRO_PACKAGE_IDENTIFIER = "$rc_monthly";
const PRO_PACKAGE_DISPLAY_NAME = "Pro Monthly";
const PRO_PRICES = [
  { amount_micros: 9990000, currency: "USD" }, // $9.99
  { amount_micros: 8990000, currency: "EUR" }, // €8.99
];

// ── Premium plan ─────────────────────────────────────────────────────────────
const PREMIUM_PRODUCT_IDENTIFIER = "hoops_premium_monthly";
const PLAY_STORE_PREMIUM_PRODUCT_IDENTIFIER = "hoops_premium_monthly:monthly";
const PREMIUM_PRODUCT_DISPLAY_NAME = "Premium Monthly";
const PREMIUM_PRODUCT_USER_FACING_TITLE = "Premium Monthly";
const PREMIUM_PRODUCT_DURATION = "P1M";
const PREMIUM_ENTITLEMENT_IDENTIFIER = "premium";
const PREMIUM_ENTITLEMENT_DISPLAY_NAME = "Premium Access";
const PREMIUM_PACKAGE_IDENTIFIER = "$rc_annual"; // re-used standard identifier for second package
const PREMIUM_PACKAGE_DISPLAY_NAME = "Premium Monthly";
const PREMIUM_PRICES = [
  { amount_micros: 19990000, currency: "USD" }, // $19.99
  { amount_micros: 17990000, currency: "EUR" }, // €17.99
];

// ── App store details ────────────────────────────────────────────────────────
const APP_STORE_APP_NAME = "Hoops Stats iOS";
const APP_STORE_BUNDLE_ID = "com.hoopsstats.app";
const PLAY_STORE_APP_NAME = "Hoops Stats Android";
const PLAY_STORE_PACKAGE_NAME = "com.hoopsstats.app";

// ── Default offering ──────────────────────────────────────────────────────────
const OFFERING_IDENTIFIER = "default";
const OFFERING_DISPLAY_NAME = "Default Offering";

type TestStorePricesResponse = {
  object: string;
  prices: { amount_micros: number; currency: string }[];
};

async function seedRevenueCat() {
  const client = await getUncachableRevenueCatClient();

  // ── Project ───────────────────────────────────────────────────────────────
  let project: Project;
  const { data: existingProjects, error: listProjectsError } = await listProjects({
    client,
    query: { limit: 20 },
  });
  if (listProjectsError) throw new Error("Failed to list projects");

  const existingProject = existingProjects.items?.find((p) => p.name === PROJECT_NAME);
  if (existingProject) {
    console.log("Project already exists:", existingProject.id);
    project = existingProject;
  } else {
    const { data: newProject, error } = await createProject({
      client,
      body: { name: PROJECT_NAME },
    });
    if (error) throw new Error("Failed to create project");
    console.log("Created project:", newProject.id);
    project = newProject;
  }

  // ── Apps ──────────────────────────────────────────────────────────────────
  const { data: apps, error: listAppsError } = await listApps({
    client,
    path: { project_id: project.id },
    query: { limit: 20 },
  });
  if (listAppsError || !apps || apps.items.length === 0) throw new Error("No apps found");

  let testStoreApp: App | undefined = apps.items.find((a) => a.type === "test_store");
  let appStoreApp: App | undefined = apps.items.find((a) => a.type === "app_store");
  let playStoreApp: App | undefined = apps.items.find((a) => a.type === "play_store");

  if (!testStoreApp) throw new Error("No test store app found");
  console.log("Test store app found:", testStoreApp.id);

  if (!appStoreApp) {
    const { data: newApp, error } = await createApp({
      client,
      path: { project_id: project.id },
      body: {
        name: APP_STORE_APP_NAME,
        type: "app_store",
        app_store: { bundle_id: APP_STORE_BUNDLE_ID },
      },
    });
    if (error) throw new Error("Failed to create App Store app");
    appStoreApp = newApp;
    console.log("Created App Store app:", appStoreApp.id);
  } else {
    console.log("App Store app found:", appStoreApp.id);
  }

  if (!playStoreApp) {
    const { data: newApp, error } = await createApp({
      client,
      path: { project_id: project.id },
      body: {
        name: PLAY_STORE_APP_NAME,
        type: "play_store",
        play_store: { package_name: PLAY_STORE_PACKAGE_NAME },
      },
    });
    if (error) throw new Error("Failed to create Play Store app");
    playStoreApp = newApp;
    console.log("Created Play Store app:", playStoreApp.id);
  } else {
    console.log("Play Store app found:", playStoreApp.id);
  }

  // ── Products ─────────────────────────────────────────────────────────────
  const { data: existingProducts, error: listProductsError } = await listProducts({
    client,
    path: { project_id: project.id },
    query: { limit: 100 },
  });
  if (listProductsError) throw new Error("Failed to list products");

  const ensureProduct = async (
    targetApp: App,
    label: string,
    storeIdentifier: string,
    displayName: string,
    userFacingTitle: string,
    duration: string,
    isTestStore: boolean,
  ): Promise<Product> => {
    const existing = existingProducts.items?.find(
      (p) => p.store_identifier === storeIdentifier && p.app_id === targetApp.id,
    );
    if (existing) {
      console.log(`${label} product already exists:`, existing.id);
      return existing;
    }
    const body: CreateProductData["body"] = {
      store_identifier: storeIdentifier,
      app_id: targetApp.id,
      type: "subscription",
      display_name: displayName,
    };
    if (isTestStore) {
      body.subscription = { duration: duration as Duration };
      body.title = userFacingTitle;
    }
    const { data, error } = await createProduct({
      client,
      path: { project_id: project.id },
      body,
    });
    if (error) throw new Error(`Failed to create ${label} product`);
    console.log(`Created ${label} product:`, data.id);
    return data;
  };

  const addTestStorePrices = async (productId: string, prices: { amount_micros: number; currency: string }[]) => {
    const { error } = await client.post<TestStorePricesResponse>({
      url: "/projects/{project_id}/products/{product_id}/test_store_prices",
      path: { project_id: project.id, product_id: productId },
      body: { prices },
    });
    if (error) {
      if (typeof error === "object" && "type" in error && error["type"] === "resource_already_exists") {
        console.log("Test store prices already exist for product:", productId);
      } else {
        throw new Error(`Failed to add test store prices for product ${productId}`);
      }
    } else {
      console.log("Added test store prices for product:", productId);
    }
  };

  // Pro products
  const testStoreProProduct = await ensureProduct(testStoreApp, "Test Store Pro", PRO_PRODUCT_IDENTIFIER, PRO_PRODUCT_DISPLAY_NAME, PRO_PRODUCT_USER_FACING_TITLE, PRO_PRODUCT_DURATION, true);
  const appStoreProProduct = await ensureProduct(appStoreApp, "App Store Pro", PRO_PRODUCT_IDENTIFIER, PRO_PRODUCT_DISPLAY_NAME, PRO_PRODUCT_USER_FACING_TITLE, PRO_PRODUCT_DURATION, false);
  const playStoreProProduct = await ensureProduct(playStoreApp, "Play Store Pro", PLAY_STORE_PRO_PRODUCT_IDENTIFIER, PRO_PRODUCT_DISPLAY_NAME, PRO_PRODUCT_USER_FACING_TITLE, PRO_PRODUCT_DURATION, false);
  await addTestStorePrices(testStoreProProduct.id, PRO_PRICES);

  // Premium products
  const testStorePremiumProduct = await ensureProduct(testStoreApp, "Test Store Premium", PREMIUM_PRODUCT_IDENTIFIER, PREMIUM_PRODUCT_DISPLAY_NAME, PREMIUM_PRODUCT_USER_FACING_TITLE, PREMIUM_PRODUCT_DURATION, true);
  const appStorePremiumProduct = await ensureProduct(appStoreApp, "App Store Premium", PREMIUM_PRODUCT_IDENTIFIER, PREMIUM_PRODUCT_DISPLAY_NAME, PREMIUM_PRODUCT_USER_FACING_TITLE, PREMIUM_PRODUCT_DURATION, false);
  const playStorePremiumProduct = await ensureProduct(playStoreApp, "Play Store Premium", PLAY_STORE_PREMIUM_PRODUCT_IDENTIFIER, PREMIUM_PRODUCT_DISPLAY_NAME, PREMIUM_PRODUCT_USER_FACING_TITLE, PREMIUM_PRODUCT_DURATION, false);
  await addTestStorePrices(testStorePremiumProduct.id, PREMIUM_PRICES);

  // ── Entitlements ─────────────────────────────────────────────────────────
  const { data: existingEntitlements, error: listEntitlementsError } = await listEntitlements({
    client,
    path: { project_id: project.id },
    query: { limit: 20 },
  });
  if (listEntitlementsError) throw new Error("Failed to list entitlements");

  const ensureEntitlement = async (lookupKey: string, displayName: string, productIds: string[]): Promise<Entitlement> => {
    const existing = existingEntitlements.items?.find((e) => e.lookup_key === lookupKey);
    let entitlement: Entitlement;
    if (existing) {
      console.log(`Entitlement '${lookupKey}' already exists:`, existing.id);
      entitlement = existing;
    } else {
      const { data, error } = await createEntitlement({
        client,
        path: { project_id: project.id },
        body: { lookup_key: lookupKey, display_name: displayName },
      });
      if (error) throw new Error(`Failed to create entitlement '${lookupKey}'`);
      console.log(`Created entitlement '${lookupKey}':`, data.id);
      entitlement = data;
    }
    const { error: attachErr } = await attachProductsToEntitlement({
      client,
      path: { project_id: project.id, entitlement_id: entitlement.id },
      body: { product_ids: productIds },
    });
    if (attachErr) {
      if (attachErr.type === "unprocessable_entity_error") {
        console.log(`Products already attached to entitlement '${lookupKey}'`);
      } else {
        throw new Error(`Failed to attach products to entitlement '${lookupKey}'`);
      }
    } else {
      console.log(`Attached products to entitlement '${lookupKey}'`);
    }
    return entitlement;
  };

  const proEntitlement = await ensureEntitlement(PRO_ENTITLEMENT_IDENTIFIER, PRO_ENTITLEMENT_DISPLAY_NAME, [
    testStoreProProduct.id, appStoreProProduct.id, playStoreProProduct.id,
  ]);
  const premiumEntitlement = await ensureEntitlement(PREMIUM_ENTITLEMENT_IDENTIFIER, PREMIUM_ENTITLEMENT_DISPLAY_NAME, [
    testStorePremiumProduct.id, appStorePremiumProduct.id, playStorePremiumProduct.id,
  ]);

  // ── Offering ─────────────────────────────────────────────────────────────
  const { data: existingOfferings, error: listOfferingsError } = await listOfferings({
    client,
    path: { project_id: project.id },
    query: { limit: 20 },
  });
  if (listOfferingsError) throw new Error("Failed to list offerings");

  let offering: Offering | undefined = existingOfferings.items?.find((o) => o.lookup_key === OFFERING_IDENTIFIER);
  if (offering) {
    console.log("Offering already exists:", offering.id);
  } else {
    const { data, error } = await createOffering({
      client,
      path: { project_id: project.id },
      body: { lookup_key: OFFERING_IDENTIFIER, display_name: OFFERING_DISPLAY_NAME },
    });
    if (error) throw new Error("Failed to create offering");
    console.log("Created offering:", data.id);
    offering = data;
  }

  if (!offering.is_current) {
    const { error } = await updateOffering({
      client,
      path: { project_id: project.id, offering_id: offering.id },
      body: { is_current: true },
    });
    if (error) throw new Error("Failed to set offering as current");
    console.log("Set offering as current");
  }

  // ── Packages ─────────────────────────────────────────────────────────────
  const { data: existingPackages, error: listPackagesError } = await listPackages({
    client,
    path: { project_id: project.id, offering_id: offering.id },
    query: { limit: 20 },
  });
  if (listPackagesError) throw new Error("Failed to list packages");

  const ensurePackage = async (
    lookupKey: string,
    displayName: string,
    productIds: { product_id: string; eligibility_criteria: "all" }[],
  ): Promise<Package> => {
    const existing = existingPackages.items?.find((p) => p.lookup_key === lookupKey);
    let pkg: Package;
    if (existing) {
      console.log(`Package '${lookupKey}' already exists:`, existing.id);
      pkg = existing;
    } else {
      const { data, error } = await createPackages({
        client,
        path: { project_id: project.id, offering_id: offering!.id },
        body: { lookup_key: lookupKey, display_name: displayName },
      });
      if (error) throw new Error(`Failed to create package '${lookupKey}'`);
      console.log(`Created package '${lookupKey}':`, data.id);
      pkg = data;
    }
    const { error: attachErr } = await attachProductsToPackage({
      client,
      path: { project_id: project.id, package_id: pkg.id },
      body: { products: productIds },
    });
    if (attachErr) {
      if (attachErr.type === "unprocessable_entity_error" && attachErr.message?.includes("Cannot attach product")) {
        console.log(`Package '${lookupKey}' already has products attached`);
      } else {
        throw new Error(`Failed to attach products to package '${lookupKey}'`);
      }
    } else {
      console.log(`Attached products to package '${lookupKey}'`);
    }
    return pkg;
  };

  await ensurePackage(PRO_PACKAGE_IDENTIFIER, PRO_PACKAGE_DISPLAY_NAME, [
    { product_id: testStoreProProduct.id, eligibility_criteria: "all" },
    { product_id: appStoreProProduct.id, eligibility_criteria: "all" },
    { product_id: playStoreProProduct.id, eligibility_criteria: "all" },
  ]);

  await ensurePackage(PREMIUM_PACKAGE_IDENTIFIER, PREMIUM_PACKAGE_DISPLAY_NAME, [
    { product_id: testStorePremiumProduct.id, eligibility_criteria: "all" },
    { product_id: appStorePremiumProduct.id, eligibility_criteria: "all" },
    { product_id: playStorePremiumProduct.id, eligibility_criteria: "all" },
  ]);

  // ── API Keys ──────────────────────────────────────────────────────────────
  const { data: testStoreApiKeys } = await listAppPublicApiKeys({
    client,
    path: { project_id: project.id, app_id: testStoreApp.id },
  });
  const { data: appStoreApiKeys } = await listAppPublicApiKeys({
    client,
    path: { project_id: project.id, app_id: appStoreApp.id },
  });
  const { data: playStoreApiKeys } = await listAppPublicApiKeys({
    client,
    path: { project_id: project.id, app_id: playStoreApp.id },
  });

  console.log("\n====================");
  console.log("RevenueCat setup complete!");
  console.log("Project ID:", project.id);
  console.log("Test Store App ID:", testStoreApp.id);
  console.log("App Store App ID:", appStoreApp.id);
  console.log("Play Store App ID:", playStoreApp.id);
  console.log("Public API Keys - Test Store:", testStoreApiKeys?.items.map((k) => k.key).join(", ") ?? "N/A");
  console.log("Public API Keys - App Store:", appStoreApiKeys?.items.map((k) => k.key).join(", ") ?? "N/A");
  console.log("Public API Keys - Play Store:", playStoreApiKeys?.items.map((k) => k.key).join(", ") ?? "N/A");
  console.log("====================\n");
  console.log("Set these environment variables:");
  console.log(`EXPO_PUBLIC_REVENUECAT_TEST_API_KEY=${testStoreApiKeys?.items[0]?.key ?? "N/A"}`);
  console.log(`EXPO_PUBLIC_REVENUECAT_IOS_API_KEY=${appStoreApiKeys?.items[0]?.key ?? "N/A"}`);
  console.log(`EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY=${playStoreApiKeys?.items[0]?.key ?? "N/A"}`);
  console.log(`REVENUECAT_PROJECT_ID=${project.id}`);
  console.log(`REVENUECAT_TEST_STORE_APP_ID=${testStoreApp.id}`);
  console.log(`REVENUECAT_APPLE_APP_STORE_APP_ID=${appStoreApp.id}`);
  console.log(`REVENUECAT_GOOGLE_PLAY_STORE_APP_ID=${playStoreApp.id}`);
}

seedRevenueCat().catch(console.error);
