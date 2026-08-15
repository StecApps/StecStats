/**
 * DEBUG VERSION — prints Podfile context to help diagnose insertion placement.
 * Once the correct structure is confirmed this debug output can be removed.
 */
const fs = require('fs');
const path = require('path');

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

    // ── DEBUG: dump full Podfile so we can see its structure ──────────────
    const debugPath = '/tmp/podfile_pre_fix.txt';
    fs.writeFileSync(debugPath, contents);
    console.log('[withSwiftConcurrencyFix] Full Podfile written to', debugPath);
    console.log('[withSwiftConcurrencyFix] Total length:', contents.length);
    console.log('[withSwiftConcurrencyFix] Total lines:', contents.split('\n').length);

    const blockHeader = 'post_install do |installer|';
    const blockStart = contents.indexOf(blockHeader);
    console.log('[withSwiftConcurrencyFix] blockHeader index:', blockStart);

    if (blockStart === -1) {
      console.warn('[withSwiftConcurrencyFix] post_install block not found — skipping.');
      return modConfig;
    }

    // Show the last 20 lines of the Podfile so we can see what follows post_install
    const lines = contents.split('\n');
    console.log('[withSwiftConcurrencyFix] Last 25 lines of Podfile:');
    lines.slice(-25).forEach((l, i) => {
      console.log(`  [${lines.length - 25 + i + 1}] ${l}`);
    });

    const callMarker = 'react_native_post_install(';
    const callStart = contents.indexOf(callMarker, blockStart);
    console.log('[withSwiftConcurrencyFix] callStart index:', callStart);

    if (callStart === -1) {
      console.warn('[withSwiftConcurrencyFix] react_native_post_install call not found — skipping.');
      return modConfig;
    }

    const openParen = callStart + callMarker.length - 1;
    console.log('[withSwiftConcurrencyFix] openParen index:', openParen, '| char:', JSON.stringify(contents[openParen]));

    const closeParen = findClosingParen(contents, openParen);
    console.log('[withSwiftConcurrencyFix] closeParen index:', closeParen, '| char:', closeParen >= 0 ? JSON.stringify(contents[closeParen]) : 'NOT FOUND');

    if (closeParen === -1) {
      console.warn('[withSwiftConcurrencyFix] Could not find closing ) — skipping.');
      return modConfig;
    }

    const afterCall = contents.slice(closeParen + 1);
    const endIdx = afterCall.indexOf('\nend');
    console.log('[withSwiftConcurrencyFix] first \\nend after closeParen at afterCall index:', endIdx);
    if (endIdx >= 0) {
      console.log('[withSwiftConcurrencyFix] characters around that \\nend:', JSON.stringify(afterCall.slice(Math.max(0, endIdx - 10), endIdx + 15)));
    }

    if (endIdx === -1) {
      console.warn('[withSwiftConcurrencyFix] Could not find post_install closing end — skipping.');
      return modConfig;
    }

    const insertAt = (closeParen + 1) + endIdx + 1;
    console.log('[withSwiftConcurrencyFix] insertAt:', insertAt);
    console.log('[withSwiftConcurrencyFix] 80 chars before insertAt:', JSON.stringify(contents.slice(Math.max(0, insertAt - 80), insertAt)));
    console.log('[withSwiftConcurrencyFix] 30 chars at insertAt:    ', JSON.stringify(contents.slice(insertAt, insertAt + 30)));

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
