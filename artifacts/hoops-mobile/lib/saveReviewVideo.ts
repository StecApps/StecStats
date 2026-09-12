import { Alert, Share } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

/**
 * Opens the native share sheet for a playable review video.
 *
 * iOS reports a user-dismissed share sheet as a rejected promise. That is an
 * expected outcome, not a save failure, so only unexpected errors alert the
 * coach.
 */
export async function saveReviewVideo(url: string, title: string): Promise<void> {
  try {
    if (url.startsWith('file:')) {
      const permission = await MediaLibrary.requestPermissionsAsync(true, ['video']);
      if (!permission.granted) {
        Alert.alert('Photos Access Needed', 'Allow StecStats to add videos to Photos, then try again.');
        return;
      }
      await MediaLibrary.saveToLibraryAsync(url);
      Alert.alert('Video Saved', `${title} was saved to Photos.`);
      return;
    }
    await Share.share({
      title,
      message: url,
      url,
    });
  } catch (error: any) {
    if (error?.message !== 'User did not share') {
      Alert.alert(
        'Save Failed',
        url.startsWith('file:')
          ? 'Photos could not save this video. Check Photos access and available device storage, then try again.'
          : 'Could not open the save sheet. Please try again.',
      );
    }
  }
}