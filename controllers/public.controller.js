/**
 * Unauthenticated endpoints (health checks, server time, public config) and
 * the cron trigger.
 */
import { env } from "../config/env.js";
import { DOMAINS, FIRST_CHOICE_DOMAINS } from "../config/enrollment.js";
import { isDbHealthy } from "../db/index.js";
import { runScheduledDispatch } from "../services/meetingLink.service.js";
import { getSettings } from "../services/settings.service.js";

/**
 * GET /api/health - "is the server up?" for Render's health check and
 * keep-alive pingers. Deliberately does NOT touch the database, so frequent
 * pings never keep Neon awake (its free plan only has 100 compute-hours/month).
 */
export function health(req, res) {
  res.json({ success: true, status: "ok", uptimeSeconds: Math.round(process.uptime()) });
}

/** GET /api/health/db - deep check including the database (use sparingly). */
export async function healthDb(req, res) {
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
      allowedBatchYears: env.allowedBatchYears,
      googleClientId: env.googleClientId || null,
      devLogin: env.devLogin,
      domains: DOMAINS,
      firstChoiceDomains: FIRST_CHOICE_DOMAINS,
      applicationsOpen: settings.applicationsOpen,
      slotBookingOpen: settings.slotBookingOpen,
      taskDurationHours: settings.taskDurationHours,
      meetingLinkLeadMinutes: settings.meetingLinkLeadMinutes,
      announcement: settings.announcement,
    },
  });
}

/**
 * POST /api/cron/meeting-links - send any meeting links that are due.
 * Safe to call every few minutes from an external cron (with CRON_SECRET):
 * it only queries the database when a link is actually due.
 */
export async function runMeetingLinkCron(req, res) {
  const result = await runScheduledDispatch();
  res.json({ success: true, data: result });
}
