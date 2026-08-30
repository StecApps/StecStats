import fs from 'fs';
import path from 'path';

describe('native Clerk proxy wiring', () => {
  const projectRoot = path.resolve(__dirname, '..');

  test('uses the proxy-capable Clerk Expo package', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    );

    expect(pkg.dependencies['@clerk/expo']).toMatch(/^\^4\./);
    expect(pkg.dependencies['@clerk/clerk-expo']).toBeUndefined();
  });

  test('passes the Release proxy URL directly to ClerkProvider', () => {
    const layout = fs.readFileSync(
      path.join(projectRoot, 'app', '_layout.tsx'),
      'utf8',
    );

    expect(layout).toContain("from '@clerk/expo'");
    expect(layout).toContain('proxyUrl={CLERK_PROXY_URL}');
    expect(layout).toContain('[Clerk] Transport:');
  });

  test('keeps existing login handlers on Clerk legacy hooks during migration', () => {
    const authScreen = fs.readFileSync(
      path.join(projectRoot, 'app', '(auth)', 'index.tsx'),
      'utf8',
    );

    expect(authScreen).toContain("from '@clerk/expo/legacy'");
  });
});