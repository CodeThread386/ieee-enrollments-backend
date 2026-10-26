/**
 * Who may enroll as a candidate.
 *
 * 1. The email must be on ALLOWED_EMAIL_DOMAIN (vitstudent.ac.in).
 * 2. If ALLOWED_BATCH_YEARS is set (e.g. "2026"), the part before the @ must
 *    end with one of those years - VIT student emails carry the joining year,
 *    e.g. rahul.sharma2026@vitstudent.ac.in.
 *
 * Used at login and on every candidate request, so tightening the rule also
 * locks out accounts that registered before it was switched on.
 */
import { env } from "../config/env.js";

/** True if the email's batch year is allowed (always true when no years are set). */
export function isAllowedBatch(email) {
  if (env.allowedBatchYears.length === 0) return true;
  const local = String(email || "").toLowerCase().split("@")[0];
  return env.allowedBatchYears.some((year) => local.endsWith(year));
}

/** Human-readable description of who can enroll, for error messages. */
export function eligibilityMessage() {
  const domain = `@${env.allowedEmailDomain}`;
  if (env.allowedBatchYears.length === 0) {
    return `Please sign in with your VIT student email (${domain})`;
  }
  const years = env.allowedBatchYears.join(" / ");
  return `Enrollments are open only for the ${years} batch - sign in with your VIT email ending in ${env.allowedBatchYears[0]}${domain}`;
}
