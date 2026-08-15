const fs = require('fs');
const path = require('path');

/**
 * Xcode 26+ enforces Swift 6 strict concurrency by default.
 * Third-party pods (expo-updates-interface, etc.) were not written for Swift 6
 * and fail to compile with "SwiftCompile" errors. Setting SWIFT_STRICT_CONCURRENCY
 * to "minimal" for all pods restores compatibility until upstream packages catch up.
 *
 * We append a second post_install block rather than patching the existing one;
 * CocoaPods merges all post_install blocks so this is safe and regex-free.
 */
function withSwiftConcurrencyFix(config) {
  const { withDangerousMod } = require('@expo/config-plugins');

  return withDangerousMod(config, [
    'ios',
    (config) => {
      const podfilePath = path.join(
        config.modRequest.platformProjectRoot,
        'Podfile'
      );

      let contents = fs.readFileSync(podfilePath, 'utf8');

      if (contents.includes('SWIFT_STRICT_CONCURRENCY')) {
        return config;
      }

      contents +=
        '\n' +
        '# Xcode 26+ Swift 6 strict-concurrency fix\n' +
        '# Third-party pods are not yet Swift 6 compliant; "minimal" restores Xcode 25 behaviour.\n' +
        'post_install do |installer|\n' +
        '  installer.pods_project.targets.each do |target|\n' +
        '    target.build_configurations.each do |config|\n' +
        "      config.build_settings['SWIFT_STRICT_CONCURRENCY'] = 'minimal'\n" +
        '    end\n' +
        '  end\n' +
        'end\n';

      fs.writeFileSync(podfilePath, contents);
      return config;
    },
  ]);
}

module.exports = withSwiftConcurrencyFix;
