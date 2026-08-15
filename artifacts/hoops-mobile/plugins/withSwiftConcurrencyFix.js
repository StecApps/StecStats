/**
 * Xcode 26+ enforces Swift 6 strict concurrency by default.
 * Third-party pods (expo-updates-interface, etc.) were not written for Swift 6
 * and fail to compile with "SwiftCompile" errors. Setting SWIFT_STRICT_CONCURRENCY
 * to "minimal" for all pods restores compatibility until upstream packages catch up.
 *
 * This plugin intentionally avoids importing @expo/config-plugins so that pnpm's
 * strict package isolation cannot block it from loading during `expo config`.
 * It replicates withDangerousMod's behaviour by directly setting config.mods.ios.dangerous.
 *
 * NOTE: CocoaPods does NOT allow multiple post_install blocks, so we inject our
 * code into the existing block rather than appending a second one.
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

    if (contents.includes('SWIFT_STRICT_CONCURRENCY')) {
      return modConfig; // already applied, idempotent
    }

    // Locate the existing post_install block (Expo always generates exactly one).
    const header = 'post_install do |installer|';
    const blockStart = contents.indexOf(header);
    if (blockStart === -1) {
      console.warn('[withSwiftConcurrencyFix] Could not find post_install block — skipping');
      return modConfig;
    }

    // Find the closing bare 'end' on its own line after the block header.
    // In the Expo-generated Podfile the post_install body contains only
    // react_native_post_install(...) and helper calls, none of which emit a
    // bare 'end' at column 0, so the first one we hit is the block's own end.
    const afterHeader = blockStart + header.length;
    const remaining = contents.slice(afterHeader);
    const endMatch = remaining.match(/\nend(\s*\n|$)/);

    if (!endMatch) {
      console.warn('[withSwiftConcurrencyFix] Could not find closing end of post_install block — skipping');
      return modConfig;
    }

    // Insert just before the bare 'end' line (after the leading \n of that match).
    const insertAt = afterHeader + endMatch.index + 1;
    const fix = [
      '  # Xcode 26+ Swift 6 strict-concurrency fix',
      '  # Third-party pods are not yet Swift 6 compliant; "minimal" restores pre-Xcode-26 behaviour.',
      '  installer.pods_project.targets.each do |target|',
      '    target.build_configurations.each do |config|',
      "      config.build_settings['SWIFT_STRICT_CONCURRENCY'] = 'minimal'",
      '    end',
      '  end',
      '',
    ].join('\n');

    contents = contents.slice(0, insertAt) + fix + contents.slice(insertAt);
    fs.writeFileSync(podfilePath, contents);

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
