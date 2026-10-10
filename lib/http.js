/**
 * Small HTTP helpers shared by every controller:
 *  - `HttpError`     throw it anywhere to send a specific status + message
 *  - `asyncHandler`  forwards rejected promises to Express' error middleware
 *  - `errorHandler`  the single place that turns errors into JSON responses
 */
import { env } from "../config/env.js";

export class HttpError extends Error {
  /**
   * @param {number} status  HTTP status code to respond with
   * @param {string} message Human readable message (shown to the user as-is)
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Wraps an async route handler so thrown errors reach `errorHandler`. */
export const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

/** Responds with 404 for any route that no router handled. */
export function notFoundHandler(req, res) {
  res.status(404).json({ success: false, message: "Route not found" });
}

/** Converts any error into a consistent `{ success: false, message }` body. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // Malformed JSON bodies.
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "Invalid JSON body" });
  }
  // Postgres: malformed value (e.g. a non-UUID id) / constraint violations.
  const pgCode = err.code || err.cause?.code;
  if (pgCode === "22P02") {
    return res.status(400).json({ success: false, message: "Invalid identifier" });
  }
  if (pgCode === "23514" || pgCode === "23505") {
    return res
      .status(409)
      .json({ success: false, message: "That conflicts with existing data. Please refresh and try again." });
  }

  const status = err.status || 500;
  if (status >= 500 && !env.isTest) {
    console.error("[error]", err);
  }
  return res.status(status).json({
    success: false,
    // Never leak internal error details to clients in production.
    message: status >= 500 && env.isProduction ? "Something went wrong" : err.message,
  });
}
