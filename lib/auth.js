/**
 * Session handling with short-lived access tokens and long-lived refresh
 * tokens, both stored in httpOnly cookies.
 *
 * Candidates and admins are separate "audiences" with their own cookie names
 * and a `kind` claim inside the JWT, so a candidate token can never be used on
 * an admin route (and logging into one never logs you out of the other).
 *
 * Refresh tokens are stored (hashed) in the `sessions` table, one row per
 * account and device, so logging out revokes them for real.
 */
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { and, eq, lt, or } from "drizzle-orm";
import { env } from "../config/env.js";
import { db, schema } from "../db/index.js";
import { HttpError } from "./http.js";

const { sessions } = schema;

const ACCESS_TTL_MS = 15 * 60 * 1000; // 15 minutes
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const COOKIE_NAMES = {
  user: { access: "ieee_user_access", refresh: "ieee_user_refresh" },
  admin: { access: "ieee_admin_access", refresh: "ieee_admin_refresh" },
};

const cookieOptions = () => ({
  httpOnly: true,
  // SameSite=None requires Secure; production always runs on HTTPS.
  secure: env.isProduction || env.cookieSameSite === "none",
  sameSite: env.cookieSameSite,
  path: "/",
});

/** Refresh tokens are stored hashed so a database leak can't be replayed. */
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

function setAccessCookie(res, kind, accountId) {
  const accessToken = jwt.sign({ sub: String(accountId), kind }, env.accessTokenSecret, {
    expiresIn: ACCESS_TTL_MS / 1000,
  });
  res.cookie(COOKIE_NAMES[kind].access, accessToken, {
    ...cookieOptions(),
    maxAge: ACCESS_TTL_MS,
  });
}

/**
 * Creates a new session for an account: replaces any previous session for
 * this device, stores the hashed refresh token and sets both cookies.
 */
export async function issueSession(res, kind, accountId, deviceId) {
  const refreshToken = jwt.sign(
    { sub: String(accountId), kind, jti: crypto.randomUUID() },
    env.refreshTokenSecret,
    { expiresIn: REFRESH_TTL_MS / 1000 }
  );

  // One session per device; also clean up this account's expired sessions.
  await db
    .delete(sessions)
    .where(
      and(
        eq(sessions.accountType, kind),
        eq(sessions.accountId, accountId),
        or(eq(sessions.deviceId, deviceId), lt(sessions.expiresAt, new Date()))
      )
    );
  await db.insert(sessions).values({
    accountType: kind,
    accountId,
    deviceId,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  });

  setAccessCookie(res, kind, accountId);
  res.cookie(COOKIE_NAMES[kind].refresh, refreshToken, {
    ...cookieOptions(),
    maxAge: REFRESH_TTL_MS,
  });
}

/**
 * Reads and verifies the access token cookie for `kind`.
 * @returns {string} the account id
 * @throws {HttpError} 401 when missing, invalid or expired
 */
export function readAccessToken(req, kind) {
  const token = req.cookies?.[COOKIE_NAMES[kind].access];
  if (!token) throw new HttpError(401, "Not logged in");
  try {
    const payload = jwt.verify(token, env.accessTokenSecret);
    if (payload.kind !== kind) throw new Error("wrong audience");
    return payload.sub;
  } catch (err) {
    throw new HttpError(
      401,
      err.name === "TokenExpiredError" ? "Session expired" : "Invalid session"
    );
  }
}

/**
 * Issues a new access token if the refresh cookie is valid and its session
 * still exists (i.e. not logged out / revoked).
 * @returns {Promise<string>} the account id
 */
export async function refreshSession(req, res, kind) {
  const token = req.cookies?.[COOKIE_NAMES[kind].refresh];
  if (!token) throw new HttpError(401, "Not logged in");

  let payload;
  try {
    payload = jwt.verify(token, env.refreshTokenSecret);
  } catch {
    throw new HttpError(401, "Session expired, please log in again");
  }
  if (payload.kind !== kind) throw new HttpError(401, "Invalid session");

  const [session] = await db
    .select({ accountId: sessions.accountId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(token)), eq(sessions.accountType, kind)));
  if (!session) throw new HttpError(401, "Session revoked, please log in again");

  setAccessCookie(res, kind, session.accountId);
  return session.accountId;
}

/** Revokes the current refresh token (if any) and clears both cookies. */
export async function clearSession(req, res, kind) {
  const token = req.cookies?.[COOKIE_NAMES[kind].refresh];
  if (token) {
    await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  }
  res.clearCookie(COOKIE_NAMES[kind].access, cookieOptions());
  res.clearCookie(COOKIE_NAMES[kind].refresh, cookieOptions());
}
