/**
 * Express application (without starting a server), so tests can import it.
 */
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./lib/http.js";
import adminRoutes from "./routes/admin.route.js";
import publicRoutes from "./routes/public.route.js";
import userRoutes from "./routes/user.route.js";

export function createApp() {
  const app = express();

  // Render / Vercel sit behind a proxy; needed for correct protocol & IPs.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(
    cors({
      origin: env.clientOrigins,
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  // API responses are personalised - never let a proxy cache them.
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/", (req, res) => res.send("IEEE-VIT Enrollments API"));
  app.use("/api", publicRoutes);
  app.use("/api/user", userRoutes);
  app.use("/api/admin", adminRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export default createApp;
