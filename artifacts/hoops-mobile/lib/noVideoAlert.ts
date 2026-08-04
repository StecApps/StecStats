import { Alert } from 'react-native';

/**
 * Shows the "No video captured" alert when handleSave finds no recorded file.
 *
 * Two distinct messages:
 *   - recordingStarted=false  → "Recording never started …"
 *   - recordingStarted=true   → "The camera started but did not produce a video file …"
 *
 * The caller is responsible for the early-return after calling this function.
 *
 * @param recordingStarted  Whether startRecording() was ever called in this session.
 * @param setSaving         Component state setter — called with false on Cancel.
 * @param saveGame          Save-without-video callback — called with null on confirm.
 */
export function showNoVideoAlert(
  recordingStarted: boolean,
  setSaving: (v: boolean) => void,
  saveGame: (videoObjectPath: string | null) => void,
): void {
  Alert.alert(
    'No video captured',
    recordingStarted
      ? 'The camera started but did not produce a video file. Save the game without video, or go back and try again.'
      : 'Recording never started (tap Play first to begin filming). Save the game without video?',
    [
      { text: 'Cancel', style: 'cancel', onPress: () => setSaving(false) },
      { text: 'Save without video', style: 'default', onPress: () => saveGame(null) },
    ],
  );
}
