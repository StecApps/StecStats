const {
  resolveBundlePath,
  verifyBundle,
} = require('../scripts/verify-ios-release-archive');

describe('iOS release archive verification', () => {
  const env = {
    APP_ENV: 'production',
    EXPO_PUBLIC_DOMAIN: 'stecstats.com',
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_expected',
    EXPO_PUBLIC_CLERK_PROXY_URL: 'https://stecstats.com/api/__clerk',
  };

  test('resolves an xcarchive to its embedded JavaScript bundle', () => {
    expect(resolveBundlePath('/tmp/StecStats.xcarchive')).toBe(
      '/tmp/StecStats.xcarchive/Products/Applications/StecStats.app/main.jsbundle',
    );
  });

  test('accepts a bundle containing every validated production value', () => {
    const existsSpy = jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
    const readSpy = jest.spyOn(require('fs'), 'readFileSync').mockReturnValue(
      Buffer.from(Object.values(env).join('|')),
    );

    expect(() => verifyBundle('/tmp/main.jsbundle', env)).not.toThrow();

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  test('rejects an archive with a stale Clerk key', () => {
    const existsSpy = jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
    const readSpy = jest.spyOn(require('fs'), 'readFileSync').mockReturnValue(
      Buffer.from(
        [
          env.APP_ENV,
          env.EXPO_PUBLIC_DOMAIN,
          'pk_live_stale',
          env.EXPO_PUBLIC_CLERK_PROXY_URL,
        ].join('|'),
      ),
    );

    expect(() => verifyBundle('/tmp/main.jsbundle', env)).toThrow(
      'EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY',
    );

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });
});