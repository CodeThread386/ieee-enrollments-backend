/**
 * Public routes - mounted at /api.
 */
import express from "express";
import * as pub from "../controllers/public.controller.js";
import { asyncHandler as h } from "../lib/http.js";
import { requireCronSecret } from "../middleware/auth.middleware.js";

const router = express.Router();

router.get("/health", pub.health);
router.get("/server-time", pub.serverTime);
router.get("/config", h(pub.publicConfig));
router.post("/cron/meeting-links", requireCronSecret, h(pub.runMeetingLinkCron));

export default router;
