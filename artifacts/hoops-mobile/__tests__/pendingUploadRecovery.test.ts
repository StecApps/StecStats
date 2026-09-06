/**
 * Regression guard: Games no longer owns a second pending-upload workflow.
 * The app-level pendingMasterUpload state machine is the sole retry owner.
 */
import fs from 'node:fs';
import path from 'node:path';

test('Games tab does not render a competing pending-upload banner or a stats-only discard action', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/(tabs)/games.tsx'), 'utf8');
  expect(source).not.toContain('PendingUploadBanner');
  expect(source).not.toContain('Save without video');
  expect(source).not.toContain('stec:pending-mobile-upload');
});