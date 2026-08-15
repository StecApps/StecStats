const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Xcode 26+ enforces Swift 6 strict concurrency by default.
 * Third-party pods (expo-updates-interface, etc.) were not written for Swift 6
 * and fail to compile with "SwiftCompile" errors. Setting SWIFT_STRICT_CONCURRENCY
 * to "minimal" for all pods restores compatibility until upstream packages catch up.
 */
function withSwiftConcurrencyFix(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const podfilePath = path.join(
        config.modRequest.platformProjectRoot,
        'Podfile'
      );

      let contents = fs.readFileSync(podfilePath, 'utf8');

      // Only inject once (idempotent)
      if (contents.includes('SWIFT_STRICT_CONCURRENCY')) {
        return config;
      }

      const fix = [
        '',
        "    # Xcode 26+ Swift 6 strict-concurrency fix — third-party pods aren't ready.",
        '    installer.pods_project.targets.each do |target|',
        '      target.build_configurations.each do |config|',
        "        config.build_settings['SWIFT_STRICT_CONCURRENCY'] = 'minimal'",
        '      end',
        '    end',
      ].join('\n');

      // Insert after the closing ) of react_native_post_install(...)
      contents = contents.replace(
        /(:ccache_enabled => ccache_enabled\?[^\n]*\n\s*\))/,
        `$1${fix}`
      );

      fs.writeFileSync(podfilePath, contents);
      return config;
    },
  ]);
}

module.exports = withSwiftConcurrencyFix;
