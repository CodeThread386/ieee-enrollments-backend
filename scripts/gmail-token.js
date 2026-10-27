/**
 * One-time helper: gets a Gmail API refresh token for the sending account.
 *   1. Put GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET in .env. With a "Web application"
 *      OAuth client, add http://127.0.0.1:53682 to its Authorized redirect URIs
 *      ("Desktop app" clients accept it as is).
 *   2. npm run gmail:token
 *   3. Open the printed URL signed in as the sending account (ieee@vit.ac.in),
 *      approve, and copy the printed GMAIL_REFRESH_TOKEN into .env and Render.
 */
import http from "node:http";
import { env } from "../config/env.js";

const { gmailClientId: clientId, gmailClientSecret: clientSecret } = env.mail;
if (!clientId || !clientSecret) {
  console.error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first.");
  process.exit(1);
}

// Fixed port: Web application clients only accept pre-registered redirect URIs.
const PORT = 53682;
const server = http.createServer();
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${server.address().port}`;

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: "https://www.googleapis.com/auth/gmail.send",
  access_type: "offline",
  // consent: forces Google to return a refresh token.
  // select_account: always show the account picker instead of using the browser's default account.
  prompt: "consent select_account",
  ...(env.mail.from ? { login_hint: env.mail.from } : {}),
}).toString();
console.log(`\nOpen this URL and approve:\n\n${authUrl}\n`);

const code = await new Promise((resolve, reject) => {
  server.on("request", (req, res) => {
    const params = new URL(req.url, redirectUri).searchParams;
    res.end(params.get("code") ? "Done - you can close this tab." : "No code received.");
    params.get("code") ? resolve(params.get("code")) : reject(new Error(params.get("error") || "no code"));
  });
});
server.close();

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  }),
});
const data = await res.json();
if (!data.refresh_token) {
  console.error("No refresh token returned:", data);
  process.exit(1);
}
console.log(`GMAIL_REFRESH_TOKEN=${data.refresh_token}`);
