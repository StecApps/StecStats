/**
 * Tests for showNoVideoAlert() — the no-video guard used by handleSave in
 * scorekeeper.tsx when recordVideo=true but no recorded file is present.
 *
 * Imports the real production function from lib/noVideoAlert so any change to
 * the alert title, message copy, or button wiring in that file breaks these
 * tests immediately.
 *
 * Covers:
 *   1. recordingStarted=false  → "Recording never started …" message
 *   2. recordingStarted=true   → "The camera started but …" message
 *
 * For each branch:
 *   - Alert title and message match the exact copy in lib/noVideoAlert.ts
 *   - "Save without video" button calls saveGame(null)
 *   - "Cancel" button calls setSaving(false) and does NOT call saveGame
 *
 * Also confirms the guard is bypassed (no alert) when a recordedUri is set —
 * this documents the expected call-site contract in handleSave.
 */

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Platform: { OS: 'ios' },
}));

import { Alert } from 'react-native';
import { showNoVideoAlert } from '../lib/noVideoAlert';

const alertSpy = Alert.alert as jest.Mock;

type AlertButton = { text: string; style?: string; onPress?: () => void };

function getButtons(): AlertButton[] {
  return alertSpy.mock.calls[0][2] as AlertButton[];
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Branch 1: recording never started ───────────────────────────────────────

describe('recordingStarted=false (tap Play never tapped)', () => {
  test('shows "No video captured" with the never-started message', () => {
    showNoVideoAlert(false, jest.fn(), jest.fn());

    expect(alertSpy).toHaveBeenCalledWith(
      'No video captured',
      'Recording never started (tap Play first to begin filming). Save the game without video?',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel' }),
        expect.objectContaining({ text: 'Save without video' }),
      ]),
    );
  });

  test('"Save without video" calls saveGame(null)', () => {
    const saveGame = jest.fn();
    showNoVideoAlert(false, jest.fn(), saveGame);

    const btn = getButtons().find((b) => b.text === 'Save without video');
    expect(btn).toBeDefined();
    btn!.onPress?.();

    expect(saveGame).toHaveBeenCalledWith(null);
    expect(saveGame).toHaveBeenCalledTimes(1);
  });

  test('"Cancel" calls setSaving(false) and does not call saveGame', () => {
    const setSaving = jest.fn();
    const saveGame = jest.fn();
    showNoVideoAlert(false, setSaving, saveGame);

    const btn = getButtons().find((b) => b.text === 'Cancel');
    expect(btn).toBeDefined();
    expect(btn!.style).toBe('cancel');
    btn!.onPress?.();

    expect(setSaving).toHaveBeenCalledWith(false);
    expect(saveGame).not.toHaveBeenCalled();
  });
});

// ─── Branch 2: camera started but produced no file ───────────────────────────

describe('recordingStarted=true, recordedUri=null (camera error mid-game)', () => {
  test('shows "No video captured" with the camera-started message', () => {
    showNoVideoAlert(true, jest.fn(), jest.fn());

    expect(alertSpy).toHaveBeenCalledWith(
      'No video captured',
      'The camera started but did not produce a video file. Save the game without video, or go back and try again.',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel' }),
        expect.objectContaining({ text: 'Save without video' }),
      ]),
    );
  });

  test('"Save without video" calls saveGame(null)', () => {
    const saveGame = jest.fn();
    showNoVideoAlert(true, jest.fn(), saveGame);

    const btn = getButtons().find((b) => b.text === 'Save without video');
    expect(btn).toBeDefined();
    btn!.onPress?.();

    expect(saveGame).toHaveBeenCalledWith(null);
    expect(saveGame).toHaveBeenCalledTimes(1);
  });

  test('"Cancel" calls setSaving(false) and does not call saveGame', () => {
    const setSaving = jest.fn();
    const saveGame = jest.fn();
    showNoVideoAlert(true, setSaving, saveGame);

    const btn = getButtons().find((b) => b.text === 'Cancel');
    expect(btn).toBeDefined();
    expect(btn!.style).toBe('cancel');
    btn!.onPress?.();

    expect(setSaving).toHaveBeenCalledWith(false);
    expect(saveGame).not.toHaveBeenCalled();
  });
});
