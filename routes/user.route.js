/**
 * Candidate routes - mounted at /api/user.
 */
import express from "express";
import * as user from "../controllers/user.controller.js";
import { asyncHandler as h } from "../lib/http.js";
import { protectUser, requireIdentity } from "../middleware/auth.middleware.js";

const router = express.Router();

// Session
router.post("/", requireIdentity, h(user.login));
router.post("/refresh-token", h(user.refresh));
router.post("/logout", h(user.logout));
router.get("/", protectUser, h(user.me));

// Stage 1 - application form
router.get("/application/form", protectUser, h(user.getApplicationForm));
router.post("/application", protectUser, h(user.submitApplication));

// Stage 2 - task submission
router.post("/task", protectUser, h(user.submitTask));

// Stage 3 - slot booking
router.get("/slots", protectUser, h(user.getSlots));
router.post("/slots/:slotId/book", protectUser, h(user.book));
router.delete("/booking", protectUser, h(user.cancel));

export default router;
