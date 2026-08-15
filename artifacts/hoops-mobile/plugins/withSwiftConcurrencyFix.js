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
 * In the Expo SDK 54 / RN 0.81 Podfile the post_install block sits INSIDE
 * target 'StecStats' do...end, so its closing "end" is indented (2 spaces).
 * A bare indexOf('\nend') skips it and hits the outer target's "end" instead.
 * We use /\n[ \t]*end\b/ so we match "end" at ANY indentation level, which
 * reliably lands on the post_install block's own closer first.
 */
const fs = require('fs');
const path = require('path');

/** Walk forward from `start` tracking paren depth until it returns to 0. */
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
    const openParen = callStart + callMarker.length - 1; // index of '('
    const closeParen = findClosingParen(contents, openParen);
    if (closeParen === -1) {
      console.warn('[withSwiftConcurrencyFix] Could not find closing ) for react_native_post_install — skipping.');
      return modConfig;
    }

    // Step 4 – find the post_install block's closing "end".
    // The post_install block lives INSIDE target 'StecStats' do...end, so its
    // "end" is indented (2 spaces). We use /\n[ \t]*end\b/ to match "end" at
    // any indentation, which reliably picks up the post_install closer first.
    const afterCall = contents.slice(closeParen + 1);
    const endMatch = afterCall.match(/\n[ \t]*end\b/);
    if (!endMatch) {
      console.warn('[withSwiftConcurrencyFix] Could not find post_install closing end — skipping.');
      return modConfig;
    }

    // Insert just after the leading \n of the match (i.e. before the "end" line).
    const insertAt = (closeParen + 1) + endMatch.index + 1;

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
