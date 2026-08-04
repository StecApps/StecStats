import { Router, type IRouter } from "express";
import fs from "fs";
import { MUSIC_TRACKS, getMusicTrackPath } from "../lib/musicTracks";

const router: IRouter = Router();

router.get("/music/tracks", (_req, res) => {
  res.json(
    MUSIC_TRACKS.map(({ id, label, description }) => {
      const filePath = getMusicTrackPath(id);
      const hasPreview = filePath !== null && fs.existsSync(filePath);
      return { id, label, description, hasPreview };
    }),
  );
});

// Stream the MP3 directly; the <audio> element handles buffering.
// Express's sendFile uses the `send` package which supports Range requests,
// so seeking within the audio element works correctly.
router.get("/music/tracks/:id/preview", (req, res) => {
  const filePath = getMusicTrackPath(req.params.id);
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).json({ error: "Track not found" });
    return;
  }
  res.sendFile(filePath);
});

export default router;
