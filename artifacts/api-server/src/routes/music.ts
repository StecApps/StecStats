import { Router, type IRouter } from "express";
import { MUSIC_TRACKS } from "../lib/musicTracks";

const router: IRouter = Router();

router.get("/music/tracks", (_req, res) => {
  res.json(MUSIC_TRACKS.map(({ id, label, description }) => ({ id, label, description })));
});

export default router;
