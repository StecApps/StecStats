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
 * INSERTION STRATEGY
 * CocoaPods forbids multiple post_install blocks. We inject our setting inside the
 * existing one by finding the LAST bare "end" in the file — which is always the
 * post_install block's closing line in every Expo-generated Podfile.
 */
const fs = require('fs');
const path = require('path');

module.exports = function withSwiftConcurrencyFix(config) {
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
      console.log('[withSwiftConcurrencyFix] Already applied — skipping.');
      return modConfig;
    }

    // Sanity-check: the post_install block must exist and use |installer|.
    if (!contents.includes('post_install do |installer|')) {
      console.warn('[withSwiftConcurrencyFix] Expected "post_install do |installer|" not found in Podfile — skipping.');
      return modConfig;
    }

    // The post_install block is always the LAST block in the Expo-generated Podfile.
    // Its closing bare "end" is therefore the last "\nend" in the file.
    const lastEndIdx = contents.lastIndexOf('\nend');
    if (lastEndIdx === -1) {
      console.warn('[withSwiftConcurrencyFix] Could not find closing end in Podfile — skipping.');
      return modConfig;
    }

    // Insert just after the \n (i.e., before the word "end"), so the fix lines
    // appear inside the post_install block directly above its closing end.
    const insertAt = lastEndIdx + 1; // +1 skips the leading \n
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

    console.log('[withSwiftConcurrencyFix] Injected SWIFT_STRICT_CONCURRENCY=minimal into post_install block.');
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
