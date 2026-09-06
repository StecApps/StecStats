import fs from 'node:fs';
import path from 'node:path';

describe('ScorekeeperScreen connectivity monitoring', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'scorekeeper.tsx'),
    'utf8',
  );

  test('subscribes to NetInfo without scheduling periodic API health fetches', () => {
    expect(source).toContain("import NetInfo from '@react-native-community/netinfo'");
    expect(source).toContain('NetInfo.addEventListener');

    expect(source).not.toContain('checkConnectivity');
    expect(source).not.toContain('connectivityIntervalRef');
    expect(source).not.toContain('/api/healthz');
    expect(source).not.toMatch(/setInterval\s*\(\s*(?:probe|checkConnectivity)\b/);
  });
});