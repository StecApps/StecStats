import {
  findRevenueCatPackages,
  getRevenueCatOfferingIssue,
  IOS_PRODUCT_IDS,
  PRO_ENTITLEMENT,
  REVENUECAT_CURRENT_OFFERING,
  REVENUECAT_PACKAGE_IDS,
} from '@/lib/revenuecatConfig';

const productionOfferings = {
  current: {
    identifier: REVENUECAT_CURRENT_OFFERING,
    availablePackages: [
      {
        identifier: REVENUECAT_PACKAGE_IDS.monthly,
        packageType: 'MONTHLY',
        product: { identifier: IOS_PRODUCT_IDS.monthly },
      },
      {
        identifier: REVENUECAT_PACKAGE_IDS.annual,
        packageType: 'ANNUAL',
        product: { identifier: IOS_PRODUCT_IDS.annual },
      },
    ],
  },
};

describe('production RevenueCat configuration', () => {
  test('uses the submitted iOS products, current offering, packages, and Pro entitlement', () => {
    expect(IOS_PRODUCT_IDS).toEqual({
      monthly: 'StecStats',
      annual: 'StecStatsAnnual',
    });
    expect(REVENUECAT_CURRENT_OFFERING).toBe('default');
    expect(REVENUECAT_PACKAGE_IDS).toEqual({
      monthly: '$rc_monthly',
      annual: '$rc_annual',
    });
    expect(PRO_ENTITLEMENT).toBe('pro');
  });

  test('accepts the complete production offering', () => {
    expect(getRevenueCatOfferingIssue({
      configured: true,
      isLoading: false,
      error: null,
      offerings: productionOfferings,
      enforceProductionIosConfig: true,
    })).toBeNull();
  });

  test('distinguishes load failures from an empty StoreKit product response', () => {
    const loadFailure = getRevenueCatOfferingIssue({
      configured: true,
      isLoading: false,
      error: new Error('network unavailable'),
      offerings: null,
      enforceProductionIosConfig: true,
    });
    const emptyProducts = getRevenueCatOfferingIssue({
      configured: true,
      isLoading: false,
      error: null,
      offerings: {
        current: { identifier: 'default', availablePackages: [] },
      },
      enforceProductionIosConfig: true,
    });

    expect(loadFailure?.title).toBe('Could not contact the App Store');
    expect(emptyProducts?.title).toBe('Apple products are not available');
    expect(emptyProducts?.message).toContain(IOS_PRODUCT_IDS.monthly);
    expect(emptyProducts?.message).toContain(IOS_PRODUCT_IDS.annual);
  });

  test('finds standard monthly and annual packages by identifier', () => {
    const packages = findRevenueCatPackages(
      productionOfferings.current.availablePackages,
    );
    expect(packages.monthly?.product?.identifier).toBe(IOS_PRODUCT_IDS.monthly);
    expect(packages.annual?.product?.identifier).toBe(IOS_PRODUCT_IDS.annual);
  });
});