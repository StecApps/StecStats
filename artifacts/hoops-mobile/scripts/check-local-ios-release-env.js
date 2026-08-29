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

const env = { ...readLocalEnv(), ...process.env };

const required = {
  APP_ENV: (value) => value === 'production',
  EXPO_PUBLIC_DOMAIN: (value) => value === 'stecstats.com',
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: (value) =>
    typeof value === 'string' && value.startsWith('pk_live_'),
  EXPO_PUBLIC_CLERK_PROXY_URL: (value) =>
    value === 'https://stecstats.com/api/__clerk',
  EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: (value) =>
    typeof value === 'string' && value.startsWith('appl_'),
};

const invalid = Object.entries(required)
  .filter(([name, isValid]) => !isValid(env[name]))
  .map(([name]) => name);

if (invalid.length > 0) {
  console.error(
    [
      'Local iOS release environment is not ready.',
      `Missing or invalid: ${invalid.join(', ')}`,
      '',
      'Copy local-ios-release.env.example to .env.local, fill in the',
      'Production Clerk publishable key, then run this command again.',
      'The key must belong to the same Production tenant shown in Replit Auth.',
    ].join('\n'),
  );
  process.exit(1);
}

console.log('Local iOS release environment validated.');