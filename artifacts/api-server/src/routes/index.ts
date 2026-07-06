import { Router, type IRouter } from "express";
import healthRouter from "./health";
import playersRouter from "./players";
import teamsRouter from "./teams";
import gamesRouter from "./games";
import highlightsRouter from "./highlights";
import importRouter from "./import";
import storageRouter from "./storage";
import liveRouter from "./live";
import billingRouter from "./billing";

const router: IRouter = Router();

router.use(healthRouter);
router.use(playersRouter);
router.use(teamsRouter);
router.use(gamesRouter);
router.use(highlightsRouter);
router.use(importRouter);
router.use(storageRouter);
router.use(liveRouter);
router.use(billingRouter);

export default router;
