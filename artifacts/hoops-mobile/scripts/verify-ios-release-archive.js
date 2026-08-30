const fs = require('fs');
const path = require('path');

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

function main() {
  // When this script is invoked through a chained pnpm/npm script, the
  // argument separator can be forwarded as a literal "--". Ignore it so the
  // documented `pnpm run ... -- /path/to/archive` form works reliably.
  const archivePath = process.argv.slice(2).find((argument) => argument !== '--');
  if (!archivePath) {
    console.error(
      'Usage: pnpm run ios:release:verify-archive -- /path/to/StecStats.xcarchive',
    );
    process.exitCode = 1;
    return;
  }

  try {
    const bundlePath = resolveBundlePath(archivePath);
    verifyBundle(bundlePath, { ...readLocalEnv(), ...process.env });
    console.log(
      'Archive verified: Release JavaScript bundle and production configuration are embedded.',
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { resolveBundlePath, verifyBundle };