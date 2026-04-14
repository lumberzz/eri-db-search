import path from "node:path";
import fs from "node:fs";
import { exec } from "node:child_process";
import express from "express";
import cors from "cors";
import { openDatabase } from "./db.js";
import { apiRouter } from "./routes/api.js";
import { resolveRuntimePaths } from "./runtimePaths.js";

// CJS-friendly entrypoint for packaging builds.
const runtime = resolveRuntimePaths(__dirname);
const startupLogPath = path.join(runtime.dataDir, "startup.log");

function logStartup(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(startupLogPath, line, "utf8");
  } catch {
    /* ignore */
  }
}

let browserOpened = false;
function openBrowserOnce(url: string): void {
  if (browserOpened) return;
  const shouldOpen =
    process.env.AUTO_OPEN_BROWSER === "1" ||
    (runtime.isPackaged && process.env.AUTO_OPEN_BROWSER !== "0");
  if (!shouldOpen) return;
  browserOpened = true;
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.warn(`Cannot auto-open browser: ${err.message}`);
      logStartup(`Cannot auto-open browser: ${err.message}`);
    }
  });
}

process.on("uncaughtException", (err) => {
  const msg = `uncaughtException: ${err.stack || err.message}`;
  console.error(msg);
  logStartup(msg);
});
process.on("unhandledRejection", (err) => {
  const msg = `unhandledRejection: ${String(err)}`;
  console.error(msg);
  logStartup(msg);
});

async function main(): Promise<void> {
  const PORT = parseInt(process.env.PORT || "8787", 10);
  const dbPath = runtime.dbPath;
  const clientDist = runtime.clientDist;
  const listenHost = process.env.HOST || "127.0.0.1";
  const appUrl = `http://${listenHost}:${PORT}`;

  const db = openDatabase(dbPath);
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", apiRouter(db, { uploadRoot: runtime.uploadRoot }));

  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      const index = path.join(clientDist, "index.html");
      if (fs.existsSync(index)) res.sendFile(index);
      else next();
    });
  }

  app.listen(PORT, listenHost, () => {
    const msg = `API ${appUrl}  (database: ${dbPath}, uploads: ${runtime.uploadRoot}, clientDist: ${clientDist})`;
    console.log(msg);
    logStartup(msg);
    openBrowserOnce(appUrl);
  });
}

main().catch((err) => {
  const msg = `startup_error: ${err.stack || err.message}`;
  console.error(msg);
  logStartup(msg);
  if (runtime.isPackaged) {
    setTimeout(() => process.exit(1), 15_000);
    return;
  }
  process.exit(1);
});
