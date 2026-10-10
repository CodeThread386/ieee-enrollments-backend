/**
 * Input validation helpers. Every value coming from a request body is checked
 * for its type here, so unexpected shapes (objects/arrays where text is
 * expected) are rejected with a clear 400 before reaching the database.
 */
import { HttpError } from "./http.js";

/**
 * Returns a trimmed string, or `null` for empty optional values.
 * @param {unknown} value
 * @param {{ field: string, required?: boolean, max?: number }} options
 */
export function cleanString(value, { field, required = false, max = 2000 }) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new HttpError(400, `${field} must be text`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (trimmed.length > max) {
    throw new HttpError(400, `${field} must be at most ${max} characters`);
  }
  return trimmed;
}

/** Validates an optional/required http(s) URL and returns it normalised. */
export function cleanUrl(value, { field, required = false, hostIncludes } = {}) {
  const str = cleanString(value, { field, required, max: 500 });
  if (str === null) return null;
  let url;
  try {
    url = new URL(str);
  } catch {
    throw new HttpError(400, `${field} must be a valid link (starting with https://)`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new HttpError(400, `${field} must start with http:// or https://`);
  }
  if (hostIncludes && !url.hostname.toLowerCase().includes(hostIncludes)) {
    throw new HttpError(400, `${field} must be a ${hostIncludes} link`);
  }
  return url.toString();
}

/** Indian mobile number: 10 digits starting with 6-9. */
export function cleanPhone(value) {
  const str = cleanString(value, { field: "Phone number", required: true, max: 20 });
  const digits = str.replace(/[\s-]/g, "").replace(/^\+91/, "");
  if (!/^[6-9]\d{9}$/.test(digits)) {
    throw new HttpError(400, "Enter a valid 10-digit Indian mobile number");
  }
  return digits;
}

/** Accepts a GitHub username or profile URL and returns the profile URL. */
export function cleanGithub(value) {
  const str = cleanString(value, { field: "GitHub profile", max: 200 });
  if (str === null) return null;
  const match = str.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}))\/?$/
  );
  if (!match) throw new HttpError(400, "Enter a valid GitHub username or profile link");
  return `https://github.com/${match[1]}`;
}

/** Ensures a value is one of the allowed options. */
export function cleanEnum(value, allowed, { field, required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new HttpError(400, `Invalid ${field}`);
  }
  return value;
}

/** Validates an integer within a range. */
export function cleanInt(value, { field, min, max, required = true }) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new HttpError(400, `${field} must be a whole number between ${min} and ${max}`);
  }
  return num;
}

/** Parses an ISO date string (must include a timezone offset or Z). */
export function cleanDate(value, { field, required = true }) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  const date = typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new HttpError(400, `Invalid ${field}`);
  return date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws 400 unless `id` is a valid UUID (all primary keys are UUIDs). */
export function assertUuid(id, field = "id") {
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new HttpError(400, `Invalid ${field}`);
  }
  return id;
}
