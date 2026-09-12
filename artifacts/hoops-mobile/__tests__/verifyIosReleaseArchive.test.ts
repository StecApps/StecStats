const {
  parseArguments,
  readBundleVersion,
  resolveBundlePath,
  resolveInfoPlistPath,
  verifyArchive,
  verifyBuildNumber,
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

  test('resolves an xcarchive to the exact embedded Info.plist', () => {
    expect(resolveInfoPlistPath('/tmp/StecStats.xcarchive')).toBe(
      '/tmp/StecStats.xcarchive/Products/Applications/StecStats.app/Info.plist',
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

  test('reads CFBundleVersion from the archive Info.plist and accepts the expected number', () => {
    const existsSpy = jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
    const readSpy = jest.spyOn(require('fs'), 'readFileSync').mockImplementation((filePath) => {
      if (String(filePath).endsWith('Info.plist')) {
        return Buffer.from(
          `<?xml version="1.0"?><plist><dict><key>CFBundleVersion</key><string>42</string></dict></plist>`,
        );
      }
      return Buffer.from(Object.values(env).join('|'));
    });

    expect(
      verifyArchive('/tmp/StecStats.xcarchive', env, {
        expectedBuildNumber: '42',
      }),
    ).toBe('42');

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  test('rejects an archive whose build number does not match the expected number', () => {
    expect(() =>
      verifyBuildNumber('41', { expectedBuildNumber: '42' }),
    ).toThrow(
      'expected CFBundleVersion 42, but the archive contains 41',
    );
  });

  test('accepts a build number at or above the required minimum', () => {
    expect(() =>
      verifyBuildNumber('42', { minimumBuildNumber: '42' }),
    ).not.toThrow();
    expect(() =>
      verifyBuildNumber('43', { minimumBuildNumber: '42' }),
    ).not.toThrow();
  });

  test('rejects a reused build number below the required minimum', () => {
    expect(() =>
      verifyBuildNumber('41', { minimumBuildNumber: '42' }),
    ).toThrow(
      'below the required minimum 42. Do not upload this archive; its build number may have been reused',
    );
  });

  test('requires exactly one build number requirement on the command line', () => {
    expect(() =>
      parseArguments(['/tmp/StecStats.xcarchive']),
    ).toThrow('--expected-build-number or --minimum-build-number');
    expect(() =>
      parseArguments([
        '/tmp/StecStats.xcarchive',
        '--expected-build-number',
        '42',
        '--minimum-build-number',
        '42',
      ]),
    ).toThrow('exactly one');
    expect(
      parseArguments([
        '--',
        '/tmp/StecStats.xcarchive',
        '--expected-build-number=42',
      ]),
    ).toEqual({
      archivePath: '/tmp/StecStats.xcarchive',
      requirement: { expectedBuildNumber: '42' },
    });
  });

  test('rejects a malformed CFBundleVersion', () => {
    expect(() =>
      verifyBuildNumber('42.1', { expectedBuildNumber: '42' }),
    ).toThrow('must be a positive whole number');
  });
});