/**
 * Unauthenticated endpoints (health check, server time, public config) and
 * the cron trigger.
 */
import { env } from "../config/env.js";
import { DOMAINS } from "../config/enrollment.js";
import { isDbHealthy } from "../db/index.js";
import { dispatchDueMeetingLinks } from "../services/meetingLink.service.js";
import { getSettings } from "../services/settings.service.js";

/** GET /api/health - used by Render's health check. */
export async function health(req, res) {
  const dbUp = await isDbHealthy();
  res.status(dbUp ? 200 : 503).json({ success: dbUp, status: dbUp ? "ok" : "db-down" });
}

/** GET /api/server-time - lets the client correct for a wrong device clock. */
export function serverTime(req, res) {
  res.json({ success: true, time: new Date().toISOString() });
}

/**
 * GET /api/config - public settings the frontend needs before login,
 * including how sign-in works (Google client ID and/or local dev login).
 */
export async function publicConfig(req, res) {
  const settings = await getSettings();
  res.json({
    success: true,
    data: {
      allowedEmailDomain: env.allowedEmailDomain,
      googleClientId: env.googleClientId || null,
      devLogin: env.devLogin,
      domains: DOMAINS,
      applicationsOpen: settings.applicationsOpen,
      slotBookingOpen: settings.slotBookingOpen,
      taskDurationHours: settings.taskDurationHours,
      meetingLinkLeadMinutes: settings.meetingLinkLeadMinutes,
      announcement: settings.announcement,
    },
  });
}

/**
 * POST /api/cron/meeting-links - run the meeting-link dispatcher.
 * Called by a Render Cron Job (or any external scheduler) with CRON_SECRET.
 */
export async function runMeetingLinkCron(req, res) {
  const result = await dispatchDueMeetingLinks();
  res.json({ success: true, data: result });
}
