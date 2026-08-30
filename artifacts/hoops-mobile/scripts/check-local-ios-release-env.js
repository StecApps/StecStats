const fs = require('fs');
const path = require('path');

const EXPECTED_CLERK_HOST = 'clerk.stecstats.stecco.org';
const REQUIRED_CLERK_STRATEGIES = ['email_code', 'oauth_token_apple'];
const PUBLISHED_ARTIFACT_PATH = path.resolve(
  __dirname,
  '../../hoops-stats/.replit-artifact/artifact.toml',
);

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

const env = { ...readLocalEnv(), ...process.env };

function getInstalledClerkExpoVersion() {
  try {
    return require('@clerk/expo/package.json').version;
  } catch {
    return null;
  }
}

function hasClerkCompatibleIosTarget() {
  try {
    const properties = JSON.parse(
      fs.readFileSync(
        path.resolve(process.cwd(), 'ios/Podfile.properties.json'),
        'utf8',
      ),
    );
    return Number.parseFloat(properties['ios.deploymentTarget']) >= 17;
  } catch {
    return false;
  }
}

function decodePublishableKeyHost(value) {
  if (typeof value !== 'string' || !value.startsWith('pk_live_')) return null;
  try {
    const encoded = value.slice('pk_live_'.length);
    return Buffer.from(encoded, 'base64url').toString('utf8').replace(/\$$/, '');
  } catch {
    return null;
  }
}

function readPublishedLegalHost() {
  const artifact = fs.readFileSync(PUBLISHED_ARTIFACT_PATH, 'utf8');
  const servicesEnv = artifact.match(
    /\[services\.env\]([\s\S]*?)(?=\n\[|$)/,
  )?.[1];
  const configuredHost = servicesEnv?.match(
    /^PUBLIC_DOMAIN\s*=\s*"([^"]+)"\s*$/m,
  )?.[1];

  if (!configuredHost) {
    throw new Error(
      `Published legal host is missing from ${PUBLISHED_ARTIFACT_PATH}.`,
    );
  }

  return configuredHost;
}

const PUBLISHED_LEGAL_HOST = readPublishedLegalHost();

function matchesPublishedLegalHost(value) {
  return value === PUBLISHED_LEGAL_HOST;
}

const required = {
  APP_ENV: (value) => value === 'production',
  EXPO_PUBLIC_DOMAIN: matchesPublishedLegalHost,
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: (value) =>
    decodePublishableKeyHost(value) === EXPECTED_CLERK_HOST,
  EXPO_PUBLIC_CLERK_PROXY_URL: (value) =>
    value === 'https://stecstats.com/api/__clerk',
  EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: (value) =>
    typeof value === 'string' && value.startsWith('appl_'),
};

const invalid = Object.entries(required)
  .filter(([name, isValid]) => !isValid(env[name]))
  .map(([name]) => name);

const clerkExpoVersion = getInstalledClerkExpoVersion();
if (!clerkExpoVersion || !clerkExpoVersion.startsWith('4.')) {
  invalid.push('@clerk/expo v4 (run pnpm install)');
}
if (!hasClerkCompatibleIosTarget()) {
  invalid.push('iOS deployment target 17.0+ (required by ClerkExpo)');
}

async function verifyClerkProxy() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(
      `${env.EXPO_PUBLIC_CLERK_PROXY_URL}/v1/environment`,
      { signal: controller.signal },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const body = await response.json();
    const factors = body?.auth_config?.first_factors;
    if (
      !Array.isArray(factors) ||
      REQUIRED_CLERK_STRATEGIES.some((strategy) => !factors.includes(strategy))
    ) {
      throw new Error('required login strategies are not enabled');
    }
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (invalid.length > 0) {
    console.error(
      [
        'Local iOS release environment is not ready.',
        `Missing or invalid: ${invalid.join(', ')}`,
        '',
        'Copy local-ios-release.env.example to .env.local, fill in the',
        'Production Clerk publishable key, then run this command again.',
        `The key must encode the expected production host: ${EXPECTED_CLERK_HOST}`,
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  try {
    await verifyClerkProxy();
  } catch (error) {
    console.error(
      [
        'Local iOS release environment is not ready.',
        'The production Clerk proxy did not pass its login-strategy check.',
        error instanceof Error ? error.message : String(error),
        '',
        'Do not archive until this check succeeds.',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Local iOS release environment validated for ${EXPECTED_CLERK_HOST}.`,
  );
}

if (require.main === module) {
  void main();
}

module.exports = {
  decodePublishableKeyHost,
  getInstalledClerkExpoVersion,
  hasClerkCompatibleIosTarget,
  matchesPublishedLegalHost,
  readPublishedLegalHost,
  verifyClerkProxy,
};
