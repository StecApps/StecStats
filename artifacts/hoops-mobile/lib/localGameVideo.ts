import AsyncStorage from '@react-native-async-storage/async-storage';

const LOCAL_GAME_VIDEO_PREFIX = '@hoops_local_game_video_v1:';
const LOCAL_GAME_VIDEO_MAX_AGE_MS = 24 * 60 * 60_000;

type LocalGameVideo = {
  uri: string;
  savedAt: number;
};

function key(gameId: number) {
  return `${LOCAL_GAME_VIDEO_PREFIX}${gameId}`;
}

export async function rememberLocalGameVideo(gameId: number, uri: string) {
  if (!uri.startsWith('file:')) return;
  const value: LocalGameVideo = { uri, savedAt: Date.now() };
  await AsyncStorage.setItem(key(gameId), JSON.stringify(value));
}

export async function getLocalGameVideo(gameId: number): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(key(gameId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<LocalGameVideo>;
    if (
      typeof value.uri !== 'string' ||
      !value.uri.startsWith('file:') ||
      typeof value.savedAt !== 'number' ||
      Date.now() - value.savedAt > LOCAL_GAME_VIDEO_MAX_AGE_MS
    ) {
      await AsyncStorage.removeItem(key(gameId));
      return null;
    }
    return value.uri;
  } catch {
    return null;
  }
}

export async function forgetLocalGameVideo(gameId: number) {
  await AsyncStorage.removeItem(key(gameId));
}