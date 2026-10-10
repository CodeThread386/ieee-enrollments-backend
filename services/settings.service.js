/**
 * Global enrollment settings (single row, key "global"), editable by
 * superadmins. Replaces the old VITE_LIVE_ROUND env switches, so opening or
 * closing stages never needs a redeploy.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";

const { settings } = schema;

/** Returns the settings row, creating it with defaults on first use. */
export async function getSettings() {
  const [row] = await db.select().from(settings).where(eq(settings.key, "global"));
  if (row) return row;
  await db.insert(settings).values({ key: "global" }).onConflictDoNothing();
  const [created] = await db.select().from(settings).where(eq(settings.key, "global"));
  return created;
}

/** Applies a partial update and returns the new settings. */
export async function updateSettings(patch) {
  await getSettings(); // make sure the row exists
  const [row] = await db.update(settings).set(patch).where(eq(settings.key, "global")).returning();
  return row;
}

/** Settings as sent to the admin panel (without internal columns). */
export function serializeSettings(row) {
  const { key, ...rest } = row; // eslint-disable-line no-unused-vars
  return rest;
}
