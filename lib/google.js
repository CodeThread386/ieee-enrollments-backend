/**
 * Verifies "Sign in with Google" ID tokens (Google Identity Services).
 *
 * The frontend renders Google's sign-in button; Google returns a signed ID
 * token (JWT) which we verify here against Google's public keys and our
 * OAuth client ID. No Firebase involved.
 */
import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env.js";

let client = null;

/**
 * @param {string} idToken  the `credential` returned by Google Identity Services
 * @returns {Promise<{ email: string, emailVerified: boolean, name?: string,
 *   picture?: string, hostedDomain?: string }>}
 * @throws if the token is invalid, expired or issued for another app
 */
export async function verifyGoogleIdToken(idToken) {
  client ||= new OAuth2Client(env.googleClientId);
  const ticket = await client.verifyIdToken({ idToken, audience: env.googleClientId });
  const payload = ticket.getPayload();
  return {
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: payload.name,
    picture: payload.picture,
    hostedDomain: payload.hd,
  };
}
