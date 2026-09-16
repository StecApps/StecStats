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

  test('settles the iPad keyboard before presenting the scorekeeper once', () => {
    expect(source).toContain('if (!canStart || startingGameRef.current) return;');
    expect(source).toContain('Keyboard.dismiss();');
    expect(source).toContain('setTimeout(resolve, 350)');
    expect(source).toContain('disabled={!canStart || startingGame}');
    expect(source).not.toContain('await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)');
  });
});