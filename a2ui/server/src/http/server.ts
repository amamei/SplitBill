import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config, logConfig } from "../config.js";
import { createScope } from "../log.js";

const logger = createScope("http.server");
const here = path.dirname(fileURLToPath(import.meta.url));
// Built web client (vite build / build --watch). Served on the API origin so the app
// also works when the Vite dev server cannot run (project path containing "#").
const webDist = path.resolve(here, "../../../web/dist");

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "15mb" }));
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    const index = path.join(webDist, "index.html");
    if (!fs.existsSync(index)) return next();
    res.sendFile(index);
  });
  return app;
}

logConfig();
const app = createApp();
app.listen(config.port, () => {
  logger.info("listening", { port: config.port, webDist: fs.existsSync(webDist) ? webDist : null });
});
