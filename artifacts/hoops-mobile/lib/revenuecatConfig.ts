export const REVENUECAT_CURRENT_OFFERING = 'default';
export const PRO_ENTITLEMENT = 'pro';
export const PREMIUM_ENTITLEMENT = 'premium';

export const REVENUECAT_PACKAGE_IDS = {
  monthly: '$rc_monthly',
  annual: '$rc_annual',
} as const;

export const IOS_PRODUCT_IDS = {
  monthly: 'StecStats',
  annual: 'StecStatsAnnual',
} as const;

type PackageLike = {
  identifier?: string | null;
  packageType?: string | null;
  product?: {
    identifier?: string | null;
    price?: number;
    priceString?: string;
  } | null;
};

type OfferingsLike = {
  current?: {
    identifier?: string | null;
    availablePackages?: PackageLike[] | null;
  } | null;
};

export interface RevenueCatOfferingIssue {
  title: string;
  message: string;
}

export function findRevenueCatPackages<T extends PackageLike>(packages: T[]): {
  monthly: T | null;
  annual: T | null;
} {
  const monthly =
    packages.find((pkg) => pkg.identifier === REVENUECAT_PACKAGE_IDS.monthly) ??
    packages.find((pkg) => pkg.packageType === 'MONTHLY') ??
    null;
  const annual =
    packages.find((pkg) => pkg.identifier === REVENUECAT_PACKAGE_IDS.annual) ??
    packages.find((pkg) => pkg.packageType === 'ANNUAL') ??
    null;

  return { monthly, annual };
}

export function getRevenueCatOfferingIssue({
  configured,
  isLoading,
  error,
  offerings,
  enforceProductionIosConfig,
}: {
  configured: boolean;
  isLoading: boolean;
  error: unknown;
  offerings: OfferingsLike | null | undefined;
  enforceProductionIosConfig: boolean;
}): RevenueCatOfferingIssue | null {
  if (!configured) {
    return {
      title: 'Subscriptions unavailable in this build',
      message:
        'This build is missing its RevenueCat iOS API key. Install the production TestFlight/App Store build or rebuild with EXPO_PUBLIC_REVENUECAT_IOS_API_KEY configured.',
    };
  }

  if (isLoading) return null;

  if (error) {
    const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
    return {
      title: 'Could not contact the App Store',
      message:
        `RevenueCat could not load Apple subscription products${detail}. Check your connection, confirm you are signed in to the App Store, then tap Retry.`,
    };
  }

  const current = offerings?.current;
  if (!current) {
    return {
      title: 'RevenueCat offering is not active',
      message:
        `RevenueCat connected, but no current offering was returned. In RevenueCat, make “${REVENUECAT_CURRENT_OFFERING}” the current offering and attach ${REVENUECAT_PACKAGE_IDS.monthly} and ${REVENUECAT_PACKAGE_IDS.annual}.`,
    };
  }

  const packages = current.availablePackages ?? [];
  if (packages.length === 0) {
    return {
      title: 'Apple products are not available',
      message:
        `The current RevenueCat offering loaded, but StoreKit returned no products. Confirm bundle ID com.hoopsstats.coach, product IDs ${IOS_PRODUCT_IDS.monthly} and ${IOS_PRODUCT_IDS.annual}, App Store agreements, pricing, storefront availability, and that both products are submitted with this build.`,
    };
  }

  const { monthly, annual } = findRevenueCatPackages(packages);
  if (!monthly || !annual) {
    const missing = [
      !monthly ? REVENUECAT_PACKAGE_IDS.monthly : null,
      !annual ? REVENUECAT_PACKAGE_IDS.annual : null,
    ].filter(Boolean).join(' and ');
    return {
      title: 'RevenueCat offering is incomplete',
      message:
        `The current offering is missing ${missing}. Attach both standard packages to the production iOS products, then tap Retry.`,
    };
  }

  if (enforceProductionIosConfig) {
    if (current.identifier !== REVENUECAT_CURRENT_OFFERING) {
      return {
        title: 'Wrong RevenueCat offering',
        message:
          `This production build received “${current.identifier ?? 'unknown'}”, but “${REVENUECAT_CURRENT_OFFERING}” must be current in RevenueCat.`,
      };
    }

    const mismatches = [
      monthly.product?.identifier === IOS_PRODUCT_IDS.monthly
        ? null
        : `${REVENUECAT_PACKAGE_IDS.monthly} → ${IOS_PRODUCT_IDS.monthly}`,
      annual.product?.identifier === IOS_PRODUCT_IDS.annual
        ? null
        : `${REVENUECAT_PACKAGE_IDS.annual} → ${IOS_PRODUCT_IDS.annual}`,
    ].filter(Boolean);

    if (mismatches.length > 0) {
      return {
        title: 'Wrong Apple products in RevenueCat',
        message: `Update the current offering package assignments: ${mismatches.join('; ')}.`,
      };
    }
  }

  return null;
}