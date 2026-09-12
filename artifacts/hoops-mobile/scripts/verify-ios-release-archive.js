const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function readLocalEnv() {
  const filePath = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(filePath)) return {};

  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).reduce((env, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return env;
    const separator = trimmed.indexOf('=');
    if (separator < 1) return env;

    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[name] = value;
    return env;
  }, {});
}

function resolveBundlePath(inputPath) {
  const resolved = path.resolve(inputPath);
  if (resolved.endsWith('.xcarchive')) {
    return path.join(
      resolved,
      'Products',
      'Applications',
      'StecStats.app',
      'main.jsbundle',
    );
  }
  if (resolved.endsWith('.app')) return path.join(resolved, 'main.jsbundle');
  return resolved;
}

function resolveInfoPlistPath(inputPath) {
  const resolved = path.resolve(inputPath);
  if (resolved.endsWith('.xcarchive')) {
    return path.join(
      resolved,
      'Products',
      'Applications',
      'StecStats.app',
      'Info.plist',
    );
  }
  if (resolved.endsWith('.app')) return path.join(resolved, 'Info.plist');
  return path.join(path.dirname(resolved), 'Info.plist');
}

function parseBuildNumber(value, sourceDescription) {
  const normalized = String(value).trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(
      `${sourceDescription} must be a positive whole number; received "${normalized}".`,
    );
  }
  return normalized;
}

function readXmlPlistBuildNumber(plistContents) {
  const match = plistContents
    .toString('utf8')
    .match(
      /<key>CFBundleVersion<\/key>\s*<(?:string|integer)>\s*([^<]+?)\s*<\/(?:string|integer)>/,
    );
  return match ? match[1] : null;
}

function readBundleVersion(infoPlistPath) {
  if (!fs.existsSync(infoPlistPath)) {
    throw new Error(
      `Info.plist was not found at ${infoPlistPath}. The archive cannot be checked for its build number.`,
    );
  }

  const plistContents = fs.readFileSync(infoPlistPath);
  const xmlBuildNumber = readXmlPlistBuildNumber(plistContents);
  if (xmlBuildNumber !== null) {
    return parseBuildNumber(
      xmlBuildNumber,
      `CFBundleVersion in ${infoPlistPath}`,
    );
  }

  try {
    const buildNumber = execFileSync(
      'plutil',
      ['-extract', 'CFBundleVersion', 'raw', '-o', '-', infoPlistPath],
      { encoding: 'utf8' },
    );
    return parseBuildNumber(
      buildNumber,
      `CFBundleVersion in ${infoPlistPath}`,
    );
  } catch {
    throw new Error(
      `CFBundleVersion could not be read from ${infoPlistPath}. The archive must contain a valid iOS Info.plist.`,
    );
  }
}

function verifyBuildNumber(actualBuildNumber, requirement) {
  if (!requirement || typeof requirement !== 'object') {
    throw new Error(
      'Build number verification requires --expected-build-number or --minimum-build-number.',
    );
  }

  const hasExpected = requirement.expectedBuildNumber !== undefined;
  const hasMinimum = requirement.minimumBuildNumber !== undefined;
  if (hasExpected === hasMinimum) {
    throw new Error(
      'Provide exactly one of --expected-build-number or --minimum-build-number.',
    );
  }

  const actual = BigInt(
    parseBuildNumber(actualBuildNumber, 'CFBundleVersion in the archive'),
  );
  const requiredValue = hasExpected
    ? parseBuildNumber(
        requirement.expectedBuildNumber,
        '--expected-build-number',
      )
    : parseBuildNumber(
        requirement.minimumBuildNumber,
        '--minimum-build-number',
      );
  const required = BigInt(requiredValue);

  if (hasExpected && actual !== required) {
    throw new Error(
      `Build number check failed: expected CFBundleVersion ${requiredValue}, but the archive contains ${actualBuildNumber}. Do not upload this archive; it uses a different build number.`,
    );
  }

  if (hasMinimum && actual < required) {
    throw new Error(
      `Build number check failed: archive CFBundleVersion ${actualBuildNumber} is below the required minimum ${requiredValue}. Do not upload this archive; its build number may have been reused.`,
    );
  }
}

function verifyBundle(bundlePath, env) {
  if (!fs.existsSync(bundlePath)) {
    throw new Error(
      `main.jsbundle was not found at ${bundlePath}. The archive is not ready for TestFlight.`,
    );
  }

  const bundle = fs.readFileSync(bundlePath);
  const expected = {
    APP_ENV: env.APP_ENV,
    EXPO_PUBLIC_DOMAIN: env.EXPO_PUBLIC_DOMAIN,
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY:
      env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
    EXPO_PUBLIC_CLERK_PROXY_URL: env.EXPO_PUBLIC_CLERK_PROXY_URL,
  };
  const missing = Object.entries(expected)
    .filter(([, value]) => typeof value !== 'string' || !value)
    .map(([name]) => `${name} (missing from .env.local)`);

  for (const [name, value] of Object.entries(expected)) {
    if (typeof value === 'string' && value && !bundle.includes(Buffer.from(value))) {
      missing.push(`${name} (not embedded in main.jsbundle)`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Archive configuration verification failed:\n- ${missing.join('\n- ')}`,
    );
  }
}

function verifyArchive(archivePath, env, requirement) {
  const resolvedArchivePath = path.resolve(archivePath);
  if (!resolvedArchivePath.endsWith('.xcarchive')) {
    throw new Error(
      `Expected an .xcarchive path, received ${archivePath}. Verify the exact archive shown in Xcode Organizer.`,
    );
  }

  const bundlePath = resolveBundlePath(resolvedArchivePath);
  verifyBundle(bundlePath, env);

  const buildNumber = readBundleVersion(
    resolveInfoPlistPath(resolvedArchivePath),
  );
  verifyBuildNumber(buildNumber, requirement);
  return buildNumber;
}

function parseArguments(argumentsList) {
  const positional = [];
  const requirement = {};

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--') continue;

    const optionMatch = argument.match(
      /^--(expected-build-number|minimum-build-number)=(.+)$/,
    );
    const optionName = optionMatch
      ? optionMatch[1]
      : argument === '--expected-build-number' ||
          argument === '--minimum-build-number'
        ? argument.slice(2)
        : null;

    if (optionName) {
      const value = optionMatch
        ? optionMatch[2]
        : argumentsList[++index];
      if (!value || value.startsWith('--')) {
        throw new Error(`Usage requires a value after --${optionName}.`);
      }
      if (optionName === 'expected-build-number') {
        requirement.expectedBuildNumber = value;
      } else {
        requirement.minimumBuildNumber = value;
      }
      continue;
    }

    positional.push(argument);
  }

  if (positional.length !== 1) {
    throw new Error(
      'Usage: pnpm run ios:release:verify-archive -- /path/to/StecStats.xcarchive --expected-build-number 42',
    );
  }

  if (
    requirement.expectedBuildNumber === undefined &&
    requirement.minimumBuildNumber === undefined
  ) {
    throw new Error(
      'Build number verification requires --expected-build-number or --minimum-build-number.',
    );
  }

  if (
    requirement.expectedBuildNumber !== undefined &&
    requirement.minimumBuildNumber !== undefined
  ) {
    throw new Error(
      'Provide exactly one of --expected-build-number or --minimum-build-number.',
    );
  }

  return { archivePath: positional[0], requirement };
}

function main() {
  // When this script is invoked through a chained pnpm/npm script, the
  // argument separator can be forwarded as a literal "--". Ignore it so the
  // documented `pnpm run ... -- /path/to/archive` form works reliably.
  try {
    const { archivePath, requirement } = parseArguments(process.argv.slice(2));
    const buildNumber = verifyArchive(
      archivePath,
      { ...readLocalEnv(), ...process.env },
      requirement,
    );
    console.log(
      `Archive verified: Release JavaScript bundle and production configuration are embedded; CFBundleVersion ${buildNumber} is ready for TestFlight.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  parseArguments,
  readBundleVersion,
  resolveBundlePath,
  resolveInfoPlistPath,
  verifyArchive,
  verifyBuildNumber,
  verifyBundle,
};