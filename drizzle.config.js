/**
 * drizzle-kit configuration - used by `npm run db:generate` to turn changes
 * in db/schema.js into SQL migration files under /drizzle.
 */
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.js",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL || "" },
});
