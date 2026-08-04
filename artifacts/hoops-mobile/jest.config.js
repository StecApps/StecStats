/** @type {import('jest').Config} */
const { transformIgnorePatterns, transform, moduleNameMapper: presetModuleNameMapper } =
  require('jest-expo/jest-preset');

module.exports = {
  // Use babel-jest with the expo preset for transformation — but skip the
  // react-native setup files that pull in ESM-only polyfills not yet
  // supported by Jest's CommonJS runner.
  transform,
  transformIgnorePatterns,
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  moduleNameMapper: {
    // honour the @/* path alias from tsconfig
    '^@/(.*)$': '<rootDir>/$1',
    // stub out asset imports
    '\\.(jpg|jpeg|png|gif|svg|ttf|otf|woff|woff2|mp4|webm|wav|mp3|aac|oga|webp)$':
      '<rootDir>/__mocks__/fileMock.js',
    // React 19 ships react-test-renderer under the 'test-renderer' specifier;
    // @testing-library/react-native resolves it by that name.
    '^test-renderer$': 'react-test-renderer',
    '^test-renderer/(.*)$': 'react-test-renderer/$1',
  },
  // Define __DEV__ before any react-native import; skip the full RN setup
  // file which pulls in ESM-only polyfills unsupported by Jest's CJS runner.
  setupFiles: ['<rootDir>/__mocks__/setup.js'],
};
