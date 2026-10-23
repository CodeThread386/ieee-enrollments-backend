/**
 * Time helpers. All dates are stored in UTC; IST is only used for display.
 */
import moment from "moment-timezone";
import { env } from "../config/env.js";

/** Formats a date for humans in IST, e.g. "Mon, 20 Oct 2025, 02:30 PM". */
export function formatIST(date) {
  return moment(date).tz(env.timezone).format("ddd, D MMM YYYY, hh:mm A");
}

/** The last moment (23:59:59.999 IST) of the IST day that `date` falls on. */
export function endOfDayIST(date) {
  return moment(date).tz(env.timezone).endOf("day").toDate();
}

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
