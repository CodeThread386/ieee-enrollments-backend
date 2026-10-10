/**
 * Centralised, validated access to environment variables.
 *
 * Every other module reads configuration from here instead of touching
 * `process.env` directly, so there is exactly one place that documents which
 * variables exist and what their defaults are. See `.env.example`.
 */
import dotenv from "dotenv";

dotenv.config();

// Force the server's global timezone to IST (console.logs, new Date(), etc.)
process.env.TZ = process.env.TZ || "Asia/Kolkata";

/** Splits a comma separated env value into a clean, lower-cased list. */
const toList = (value) =>
  (value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

export const env = {
  nodeEnv,
  isProduction,
  isTest: nodeEnv === "test",
  port: Number(process.env.PORT) || 5000,

  // Neon Postgres connection string, or "pglite://memory" for an in-memory
  // database (tests / local runs that must not touch Neon).
  databaseUrl: process.env.DATABASE_URL,

  // Origins allowed to call the API with credentials (cookies).
  // APPLICATION_URL is kept for backwards compatibility with the old setup.
  clientOrigins: [
    ...toList(process.env.CLIENT_ORIGINS),
    ...toList(process.env.APPLICATION_URL),
    "http://localhost:5173",
    "http://localhost:4173",
  ],

  accessTokenSecret: process.env.ACCESS_TOKEN_SECRET,
  refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET,

  // "lax" works when the frontend proxies /api through its own domain (the
  // default Vercel setup in this project). Use "none" only if the browser
  // calls the backend's onrender.com URL directly from another site.
  cookieSameSite: (process.env.COOKIE_SAMESITE || "lax").toLowerCase(),

  // Public URL of the frontend, used for links inside emails.
  appUrl: (process.env.APP_URL || "").replace(/\/$/, ""),

  // Only Google accounts on this domain can register as candidates.
  allowedEmailDomain: (
    process.env.ALLOWED_EMAIL_DOMAIN || "vitstudent.ac.in"
  ).toLowerCase(),

  // Admin access is granted purely by these allow-lists (checked on every request).
  adminEmails: toList(process.env.ADMIN_EMAILS),
  superadminEmails: toList(process.env.SUPERADMIN_EMAILS),

  // OAuth 2.0 Web client ID from Google Cloud Console, used to verify the
  // "Sign in with Google" ID tokens the frontend sends.
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",

  // Local testing only: lets the sign-in page log in with any email, no
  // Google account needed. The server refuses to start with this in production.
  devLogin: process.env.DEV_LOGIN === "true",

  mail: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
    from: process.env.MAIL_FROM || process.env.MAIL_USER,
  },

  // Shared secret that external schedulers (Render cron, cron-job.org, ...)
  // must send to trigger background jobs over HTTP.
  cronSecret: process.env.CRON_SECRET,

  // Runs the meeting-link dispatcher inside the web process every minute.
  // Safe to keep on alongside an external cron: the job is idempotent.
  enableInternalScheduler: process.env.ENABLE_INTERNAL_SCHEDULER !== "false",

  timezone: "Asia/Kolkata",
};

/**
 * Fails fast at boot if a variable the server cannot run without is missing.
 * Called from `server.js` (not at import time) so tests can configure env first.
 */
export function assertRequiredEnv() {
  const required = {
    DATABASE_URL: env.databaseUrl,
    ACCESS_TOKEN_SECRET: env.accessTokenSecret,
    REFRESH_TOKEN_SECRET: env.refreshTokenSecret,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (!env.googleClientId && !env.devLogin) {
    missing.push("GOOGLE_CLIENT_ID (or DEV_LOGIN=true for local testing)");
  }
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  if (env.isProduction && env.devLogin) {
    throw new Error("DEV_LOGIN must never be enabled in production - anyone could log in as anyone.");
  }
  if (env.devLogin) {
    console.warn("[env] DEV_LOGIN is ON - email-only login is enabled (local testing only).");
  }
  if (env.adminEmails.length === 0 && env.superadminEmails.length === 0) {
    console.warn("[env] No ADMIN_EMAILS / SUPERADMIN_EMAILS set - nobody can log in as admin.");
  }
}
