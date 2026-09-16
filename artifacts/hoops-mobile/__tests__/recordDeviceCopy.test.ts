import fs from 'fs';
import path from 'path';

describe('recording device copy', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../app/(tabs)/record.tsx'),
    'utf8',
  );

  test('does not describe iPad recording as phone-only', () => {
    expect(source).toContain('Film the game from this device');
    expect(source).not.toContain('Film the game from your phone');
  });
});