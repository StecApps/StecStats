const { spawnSync } = require('node:child_process');
const eas = require('../eas.json');

const productionEnv = eas.build?.production?.env;
if (!productionEnv) {
  console.error('Missing build.production.env in eas.json');
  process.exit(1);
}

const requiredVariables = [
  'EXPO_PUBLIC_DOMAIN',
  'EXPO_PUBLIC_CLERK_PROXY_URL',
];
const missingVariables = requiredVariables.filter((name) => !productionEnv[name]);

if (missingVariables.length > 0) {
  console.error(
    `Missing required production update variables: ${missingVariables.join(', ')}`,
  );
  process.exit(1);
}

const result = spawnSync(
  'pnpm',
  [
    'dlx',
    'eas-cli@latest',
    'update',
    '--channel',
    'production',
    '--environment',
    'production',
    '--message',
    process.env.MESSAGE || 'production release',
  ],
  {
    env: { ...process.env, ...productionEnv },
    stdio: 'inherit',
  },
);

process.exit(result.status ?? 1);