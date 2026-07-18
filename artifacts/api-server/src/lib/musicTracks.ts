import path from "path";

export const MUSIC_TRACKS = [
  { id: "energetic", label: "Energetic", description: "High-energy uptempo" },
  { id: "upbeat",    label: "Upbeat",    description: "Fun, positive groove" },
  { id: "dynamic",   label: "Dynamic",   description: "Driving, powerful beat" },
] as const;

export type MusicTrackId = (typeof MUSIC_TRACKS)[number]["id"];

const VALID_IDS = new Set(MUSIC_TRACKS.map((t) => t.id));

const MUSIC_DIR = path.resolve(__dirname, "..", "assets", "music");

export function getMusicTrackPath(trackId: string): string | null {
  if (!VALID_IDS.has(trackId as MusicTrackId)) return null;
  return path.join(MUSIC_DIR, `${trackId}.mp3`);
}
