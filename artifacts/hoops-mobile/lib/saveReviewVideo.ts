import { Alert, Share } from 'react-native';

/**
 * Opens the native share sheet for a playable review video.
 *
 * iOS reports a user-dismissed share sheet as a rejected promise. That is an
 * expected outcome, not a save failure, so only unexpected errors alert the
 * coach.
 */
export async function saveReviewVideo(url: string, title: string): Promise<void> {
  try {
    await Share.share({
      title,
      message: url,
      url,
    });
  } catch (error: any) {
    if (error?.message !== 'User did not share') {
      Alert.alert('Save Failed', 'Could not open the save sheet. Please try again.');
    }
  }
}