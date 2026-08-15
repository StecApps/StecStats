/**
 * Xcode 26+ enforces Swift 6 strict concurrency by default.
 * Third-party pods (expo-updates-interface, etc.) were not written for Swift 6
 * and fail to compile with "SwiftCompile" errors. Setting SWIFT_STRICT_CONCURRENCY
 * to "minimal" for all pods restores compatibility until upstream packages catch up.
 *
 * This plugin intentionally avoids importing @expo/config-plugins so that pnpm's
 * strict package isolation cannot block it from loading during `expo config`.
 * It replicates withDangerousMod's behaviour by directly setting config.mods.ios.dangerous.
 */
const fs = require('fs');
const path = require('path');

module.exports = function withSwiftConcurrencyFix(config) {
  // Preserve any previously registered dangerous mod and chain ours after it.
  const prevMod = config.mods?.ios?.dangerous;

  const newMod = async (modConfig) => {
    if (prevMod) {
      modConfig = await prevMod(modConfig);
    }

    const podfilePath = path.join(
      modConfig.modRequest.platformProjectRoot,
      'Podfile'
    );

    let contents = fs.readFileSync(podfilePath, 'utf8');

    if (!contents.includes('SWIFT_STRICT_CONCURRENCY')) {
      // Append a second post_install block — CocoaPods merges all of them,
      // so this is safe and requires no regex surgery on the existing block.
      contents +=
        '\n' +
        '# Xcode 26+ Swift 6 strict-concurrency fix\n' +
        '# Third-party pods are not yet Swift 6 compliant; "minimal" restores pre-Xcode-26 behaviour.\n' +
        'post_install do |installer|\n' +
        '  installer.pods_project.targets.each do |target|\n' +
        '    target.build_configurations.each do |config|\n' +
        "      config.build_settings['SWIFT_STRICT_CONCURRENCY'] = 'minimal'\n" +
        '    end\n' +
        '  end\n' +
        'end\n';

      fs.writeFileSync(podfilePath, contents);
    }

    return modConfig;
  };

  return {
    ...config,
    mods: {
      ...(config.mods || {}),
      ios: {
        ...((config.mods || {}).ios || {}),
        dangerous: newMod,
      },
    },
  };
};
