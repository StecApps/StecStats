/**
 * Inspects the current RevenueCat state: apps, products, entitlements, offerings, packages.
 */
import { getUncachableRevenueCatClient } from "./revenueCatClient";
import {
  listProjects,
  listApps,
  listProducts,
  listEntitlements,
  listOfferings,
  listPackages,
  getProductsFromPackage,
  getProductsFromEntitlement,
} from "@replit/revenuecat-sdk";

async function inspect() {
  const client = await getUncachableRevenueCatClient();
  const projectId = process.env.REVENUECAT_PROJECT_ID!;

  console.log("=== APPS ===");
  const { data: apps } = await listApps({ client, path: { project_id: projectId }, query: { limit: 20 } });
  for (const app of apps?.items ?? []) {
    console.log(`  [${app.type}] ${app.name} — id: ${app.id}`);
  }

  console.log("\n=== PRODUCTS ===");
  const { data: products } = await listProducts({ client, path: { project_id: projectId }, query: { limit: 100 } });
  for (const p of products?.items ?? []) {
    const appName = apps?.items.find(a => a.id === p.app_id)?.type ?? p.app_id;
    console.log(`  [${appName}] ${p.display_name} — store_id: ${p.store_identifier} — id: ${p.id}`);
  }

  console.log("\n=== ENTITLEMENTS ===");
  const { data: entitlements } = await listEntitlements({ client, path: { project_id: projectId }, query: { limit: 20 } });
  for (const e of entitlements?.items ?? []) {
    const { data: ep } = await getProductsFromEntitlement({ client, path: { project_id: projectId, entitlement_id: e.id }, query: { limit: 20 } });
    const productIds = ep?.items?.map(p => p.store_identifier).join(", ") ?? "none";
    console.log(`  ${e.lookup_key} (${e.display_name}) — products: ${productIds}`);
  }

  console.log("\n=== OFFERINGS & PACKAGES ===");
  const { data: offerings } = await listOfferings({ client, path: { project_id: projectId }, query: { limit: 20 } });
  for (const o of offerings?.items ?? []) {
    console.log(`  Offering: ${o.lookup_key} (current=${o.is_current}) — id: ${o.id}`);
    const { data: pkgs } = await listPackages({ client, path: { project_id: projectId, offering_id: o.id }, query: { limit: 20 } });
    for (const pkg of pkgs?.items ?? []) {
      const { data: pp } = await getProductsFromPackage({ client, path: { project_id: projectId, package_id: pkg.id }, query: { limit: 20 } });
      const productStoreIds = pp?.items
        ?.map((relation: any) => relation.product?.store_identifier ?? relation.store_identifier)
        .filter(Boolean)
        .join(", ") || "none";
      console.log(`    Package: ${pkg.lookup_key} (${pkg.display_name}) — id: ${pkg.id} — products: ${productStoreIds}`);
    }
  }
}

inspect().catch(console.error);
