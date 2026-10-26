/**
 * Authentication / authorisation middleware.
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { env } from "../config/env.js";
import { db, schema } from "../db/index.js";
import { readAccessToken } from "../lib/auth.js";
import { eligibilityMessage, isAllowedBatch } from "../lib/eligibility.js";
import { verifyGoogleIdToken } from "../lib/google.js";
import { asyncHandler, HttpError } from "../lib/http.js";
import { loadCandidate } from "../services/candidate.service.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns "superadmin", "admin" or null for an email based on the allow-lists. */
export function getAdminRole(email) {
  const normalised = String(email || "").toLowerCase();
  if (env.superadminEmails.includes(normalised)) return "superadmin";
  if (env.adminEmails.includes(normalised)) return "admin";
  return null;
}

/**
 * Works out who is logging in and stores it on `req.identity`
 * (`{ email, emailVerified, name, picture, hostedDomain }`).
 *
 * - Normal: body `{ credential }` = the ID token from "Sign in with Google",
 *   verified against Google's keys and our GOOGLE_CLIENT_ID.
 * - Local testing (DEV_LOGIN=true, never in production): body
 *   `{ devEmail, devName }` - no Google account needed.
 */
export const requireIdentity = asyncHandler(async (req, res, next) => {
  const body = req.body || {};

  if (env.devLogin && body.devEmail !== undefined) {
    const email = typeof body.devEmail === "string" ? body.devEmail.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "Enter a valid email address");
    const name = typeof body.devName === "string" && body.devName.trim() ? body.devName.trim() : email.split("@")[0];
    req.identity = { email, emailVerified: true, name: name.slice(0, 100), picture: null };
    return next();
  }

  if (typeof body.credential !== "string" || !body.credential) {
    throw new HttpError(401, "Missing Google sign-in credential");
  }
  if (!env.googleClientId) throw new HttpError(503, "Google sign-in is not configured on the server");
  try {
    req.identity = await verifyGoogleIdToken(body.credential);
  } catch {
    throw new HttpError(401, "Google sign-in could not be verified. Please try again.");
  }
  next();
});

/** Requires a logged-in candidate; sets `req.candidate` (with all stage data). */
export const protectUser = asyncHandler(async (req, res, next) => {
  const userId = readAccessToken(req, "user");
  const candidate = await loadCandidate(userId);
  if (!candidate) throw new HttpError(401, "Account not found");
  // Batch rule applies to existing sessions too (e.g. accounts made before it was set).
  if (!isAllowedBatch(candidate.email)) throw new HttpError(403, eligibilityMessage());
  req.candidate = candidate;
  next();
});

/**
 * Requires a logged-in admin who is *still* on the allow-list; sets
 * `req.admin` and `req.adminRole`.
 */
export const protectAdmin = asyncHandler(async (req, res, next) => {
  const adminId = readAccessToken(req, "admin");
  const [admin] = await db.select().from(schema.admins).where(eq(schema.admins.id, adminId));
  if (!admin) throw new HttpError(401, "Admin account not found");
  const role = getAdminRole(admin.email);
  if (!role) throw new HttpError(403, "Your admin access has been revoked");
  req.admin = admin;
  req.adminRole = role;
  next();
});

/** Restricts a route to superadmins (must run after `protectAdmin`). */
export function requireSuperadmin(req, res, next) {
  if (req.adminRole !== "superadmin") {
    return next(new HttpError(403, "Only superadmins can do this"));
  }
  next();
}

/**
 * Protects cron endpoints. Accepts `Authorization: Bearer <CRON_SECRET>` or
 * `x-cron-secret: <CRON_SECRET>`. Disabled entirely when no secret is set.
 */
export function requireCronSecret(req, res, next) {
  if (!env.cronSecret) return next(new HttpError(503, "Cron endpoint is not configured"));
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : String(req.headers["x-cron-secret"] || "");
  const a = Buffer.from(provided);
  const b = Buffer.from(env.cronSecret);
  // Constant-time comparison to avoid leaking the secret through timing.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(new HttpError(401, "Invalid cron secret"));
  }
  next();
}
