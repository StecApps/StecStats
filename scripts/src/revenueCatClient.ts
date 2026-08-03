import { createClient } from "@replit/revenuecat-sdk/client";

/**
 * Fetches RevenueCat credentials from the Replit connector API.
 * Not cached — tokens can rotate, so fetch fresh each time.
 */
async function getRevenueCatApiKey(): Promise<string> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    throw new Error(
      "Missing Replit environment variables. " +
        "Ensure the RevenueCat integration is connected via the Integrations tab.",
    );
  }

  const resp = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true`,
    {
      headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!resp.ok) {
    throw new Error(`Failed to fetch connector credentials: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as {
    items?: Array<{ connector_name?: string; settings?: Record<string, string | undefined> }>;
  };

  const connection = data.items?.find((item) => item.connector_name === "revenuecat");
  const settings = connection?.settings;

  if (!settings) {
    throw new Error(
      "RevenueCat integration not connected or missing credentials. " +
        "Connect RevenueCat via the Integrations tab first.",
    );
  }

  // RevenueCat connector exposes an OAuth access_token
  const apiKey = settings.access_token ?? settings.api_key ?? settings.secret_key ?? settings.secret;

  if (!apiKey) {
    console.error("RevenueCat settings keys available:", Object.keys(settings));
    throw new Error(
      "RevenueCat API key not found in connector settings. " +
        "Check the integration is properly authorized.",
    );
  }

  return apiKey;
}

/**
 * Returns a fresh authenticated RevenueCat API client.
 * Not cached — fetches credentials on every call so rotated keys are picked up.
 */
export async function getUncachableRevenueCatClient() {
  const apiKey = await getRevenueCatApiKey();
  return createClient({
    baseUrl: "https://api.revenuecat.com/v2",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
}
