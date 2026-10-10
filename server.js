/**
 * Entry point: validates env, connects to Postgres (applying any pending
 * migrations), starts the HTTP server and the meeting-link scheduler.
 *
 * On Render this is started with `npm start`; Render provides PORT.
 */
import { assertRequiredEnv, env } from "./config/env.js";
import { createApp } from "./app.js";
import { connectDB, disconnectDB } from "./db/index.js";
import { startMeetingLinkScheduler } from "./services/meetingLink.service.js";

async function main() {
  assertRequiredEnv();
  await connectDB(env.databaseUrl);

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`[server] listening on port ${env.port} (${env.nodeEnv})`);
  });

  const stopScheduler = env.enableInternalScheduler ? startMeetingLinkScheduler() : () => {};

  // Graceful shutdown so in-flight requests finish during Render deploys.
  const shutdown = (signal) => {
    console.log(`[server] ${signal} received, shutting down`);
    stopScheduler();
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[server] failed to start:", err.message);
  process.exit(1);
});
