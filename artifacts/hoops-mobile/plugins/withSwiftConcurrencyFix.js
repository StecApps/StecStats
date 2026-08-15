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
 * CocoaPods forbids multiple post_install blocks, and simple text search for "end"
 * is ambiguous (the Expo Podfile template defines ccache_enabled? AFTER post_install).
 * Instead we:
 *   1. Find react_native_post_install( inside the post_install block.
 *   2. Walk forward tracking parentheses to find its closing ).
 *   3. Take the first bare \nend after that ) — unambiguously the post_install closer.
 *   4. Insert our Ruby lines just before that end.
 */
const fs = require('fs');
const path = require('path');

/** Walk forward from `start` in `text` tracking paren depth until depth returns to 0. */
function findClosingParen(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

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

    // Step 1 – locate the post_install block.
    const blockHeader = 'post_install do |installer|';
    const blockStart = contents.indexOf(blockHeader);
    if (blockStart === -1) {
      console.warn('[withSwiftConcurrencyFix] post_install block not found — skipping.');
      return modConfig;
    }

    // Step 2 – find react_native_post_install( inside that block.
    const callMarker = 'react_native_post_install(';
    const callStart = contents.indexOf(callMarker, blockStart);
    if (callStart === -1) {
      console.warn('[withSwiftConcurrencyFix] react_native_post_install call not found — skipping.');
      return modConfig;
    }

    // Step 3 – find its closing ) by tracking parens (handles multi-line args).
    const openParen = callStart + callMarker.length - 1; // index of the '('
    const closeParen = findClosingParen(contents, openParen);
    if (closeParen === -1) {
      console.warn('[withSwiftConcurrencyFix] Could not find closing ) for react_native_post_install — skipping.');
      return modConfig;
    }

    // Step 4 – the FIRST \nend after that ) is unambiguously the post_install closer.
    const afterCall = contents.slice(closeParen + 1);
    const endIdx = afterCall.indexOf('\nend');
    if (endIdx === -1) {
      console.warn('[withSwiftConcurrencyFix] Could not find post_install closing end — skipping.');
      return modConfig;
    }

    // Insert just after the leading \n (i.e. our lines appear before the bare "end").
    const insertAt = (closeParen + 1) + endIdx + 1;

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
