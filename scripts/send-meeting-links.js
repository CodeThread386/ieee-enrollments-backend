/**
 * One-shot meeting-link dispatch, for a Render Cron Job:
 *   Command:  npm run cron:meeting-links
 *   Schedule: every 5 minutes  (e.g. "*\/5 * * * *")
 *
 * Connects to the database directly, so it works even while the web service
 * is asleep. Safe to run alongside the in-process scheduler (idempotent).
 */
import { env } from "../config/env.js";
import { connectDB, disconnectDB } from "../db/index.js";
import { dispatchDueMeetingLinks } from "../services/meetingLink.service.js";

try {
  await connectDB(env.databaseUrl);
  const result = await dispatchDueMeetingLinks();
  console.log("[cron] meeting links:", JSON.stringify(result));
  await disconnectDB();
  process.exit(0);
} catch (err) {
  console.error("[cron] failed:", err.message);
  process.exit(1);
}
