/**
 * Admin routes - mounted at /api/admin.
 */
import express from "express";
import * as admin from "../controllers/admin.controller.js";
import { asyncHandler as h } from "../lib/http.js";
import {
  protectAdmin,
  requireIdentity,
  requireSuperadmin as superOnly,
} from "../middleware/auth.middleware.js";

const router = express.Router();

// Session (no protection - these establish/refresh/clear it)
router.post("/", requireIdentity, h(admin.login));
router.post("/refresh-token", h(admin.refresh));
router.post("/logout", h(admin.logout));

// Everything below requires an allow-listed admin.
router.use(protectAdmin);

router.get("/", h(admin.me));
router.get("/stats", h(admin.stats));

// Candidates
router.get("/candidates", h(admin.listCandidates));
router.get("/candidates/export", superOnly, h(admin.exportCandidates));
router.get("/candidates/:id", h(admin.getCandidate));
router.put("/candidates/:id/interview", h(admin.reviewCandidate));
router.put("/candidates/:id/task-deadline", superOnly, h(admin.extendTaskDeadline));
router.delete("/candidates/:id/booking", superOnly, h(admin.removeBooking));

// Task bank
router.get("/tasks", h(admin.listTasks));
router.post("/tasks", superOnly, h(admin.createTask));
router.put("/tasks/:id", superOnly, h(admin.updateTask));
router.delete("/tasks/:id", superOnly, h(admin.deleteTask));

// Interview slots
router.get("/slots", h(admin.listSlots));
router.post("/slots", superOnly, h(admin.createSlots));
router.put("/slots/:id", h(admin.updateSlot)); // role checks are per field
router.delete("/slots/:id", superOnly, h(admin.deleteSlot));
router.post("/slots/:id/interviewers/me", h(admin.toggleInterviewer));
router.post("/slots/:id/send-links", h(admin.sendSlotLinks));

// Settings
router.get("/settings", h(admin.getSettingsHandler));
router.put("/settings", superOnly, h(admin.updateSettingsHandler));

export default router;
