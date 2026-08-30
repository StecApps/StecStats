# Production legal-page verification

Verified on August 30, 2026 after confirming the active deployment is public and healthy.

## Public routes

Each route returned HTTP 200 and loaded `/assets/index-BkK1obNZ.js`.

- `https://stecstats.stecco.org/privacy`
- `https://stecstats.stecco.org/terms`
- `https://stecstats.com/privacy`
- `https://stecstats.com/terms`
- `https://StecStats.replit.app/privacy`
- `https://StecStats.replit.app/terms`

The deployed bundle contains `support@stecstats.com` 12 times and contains no occurrence of `sstec@stecco.org`.

## Mobile Profile links

The mobile Profile screen opens the canonical HTTPS `/privacy` and `/terms` routes. The focused legal-link Jest suite passes all 10 tests.

## Build checks

- Hoops Stats TypeScript check passed.
- Hoops Stats production build passed.

Fresh rendered captures are stored in:

- `screenshots/privacy-page-production.png`
- `screenshots/terms-page-production.png`