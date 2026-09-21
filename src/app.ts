import express, { Express } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env";
import routes from "./routes";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { UPLOAD_ROOT_DIR } from "./utils/fms/upload";

export function createApp(): Express {
  const app = express();

  // Branding assets (logo) are fetched cross-origin by the frontend, so
  // relax the default same-origin resource policy for this public API.
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json());

  if (env.NODE_ENV !== "test") {
    app.use(morgan(env.NODE_ENV === "development" ? "dev" : "combined"));
  }

  app.get("/health", (_req, res) => {
    res.json({ success: true, data: { status: "ok" } });
  });

  app.use("/uploads", express.static(UPLOAD_ROOT_DIR));

  app.use("/api", routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
