/**
 * Canonical feature-list copy for Free / Pro / Premium plan tiers.
 *
 * This is the single source of truth consumed by:
 *   - artifacts/hoops-stats/src/pages/pricing.tsx
 *   - artifacts/hoops-stats/src/pages/billing.tsx
 *   - artifacts/hoops-mobile/app/paywall.tsx
 *
 * Edit copy HERE only — never in the consumer files.
 */

export const FREE_FEATURES: string[] = [
  '1 player',
  'Current season stats',
  'Basic box scores',
];

export const PRO_FEATURES: string[] = [
  'Unlimited players & seasons',
  'Full career dashboard',
  'Shooting gauges & advanced stats',
  'Live streaming to family & fans',
  'Saved game video & highlight reels',
  'YouTube highlight upload with auto box score',
  'Shareable player profile',
];

export const PREMIUM_FEATURES: string[] = [
  'Everything in Pro',
  'Auto-Follow camera during recording',
  'Player tracking photos',
  'More features coming',
];
