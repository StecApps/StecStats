import { Router, type IRouter } from "express";
import healthRouter from "./health";
import playersRouter from "./players";
import teamsRouter from "./teams";
import gamesRouter from "./games";
import importRouter from "./import";
import storageRouter from "./storage";
import liveRouter from "./live";

const router: IRouter = Router();

router.use(healthRouter);
router.use(playersRouter);
router.use(teamsRouter);
router.use(gamesRouter);
router.use(importRouter);
router.use(storageRouter);
router.use(liveRouter);

export default router;
