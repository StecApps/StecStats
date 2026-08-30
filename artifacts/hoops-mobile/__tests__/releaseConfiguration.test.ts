import fs from 'node:fs';
import path from 'node:path';

const mobileRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(mobileRoot, '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(repositoryRoot, relativePath), 'utf8');
}

describe('iOS release configuration and legal surfaces', () => {
  test('production build uses the released bundle and a RevenueCat iOS public key', () => {
    const app = JSON.parse(read('artifacts/hoops-mobile/app.json'));
    const eas = JSON.parse(read('artifacts/hoops-mobile/eas.json'));

    expect(app.expo.ios.bundleIdentifier).toBe('com.hoopsstats.coach');
    expect(
      eas.build.production.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY,
    ).toMatch(/^appl_/);
  });

  test('release docs agree on product IDs, packages, offering, and entitlement', () => {
    const docs = [
      read('artifacts/hoops-mobile/app-store/SUBMISSION-CHECKLIST.md'),
      read('artifacts/hoops-mobile/app-store/review-notes.md'),
      read('artifacts/hoops-mobile/docs/revenuecat-annual-setup.md'),
    ].join('\n');

    expect(docs).toContain('com.stecapps.stecstats.pro.monthly');
    expect(docs).toContain('com.stecapps.stecstats.pro.annualDeal');
    expect(docs).toContain('$rc_monthly');
    expect(docs).toContain('$rc_annual');
    expect(docs).toContain('`default`');
    expect(docs).toContain('`pro`');
    expect(docs).not.toContain('com.hoopsstats.coach.pro_annual');
  });

  test('all legal pages use the canonical support address and Terms link Apple’s EULA', () => {
    const legalPages = [
      read('artifacts/hoops-stats/src/pages/privacy.tsx'),
      read('artifacts/hoops-stats/src/pages/terms.tsx'),
      read('artifacts/hoops-stats/src/pages/account-deletion.tsx'),
    ];

    for (const page of legalPages) {
      expect(page).toContain('support@stecstats.com');
    }
    expect(legalPages[1]).toContain(
      'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/',
    );
  });
});