import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export type RuntimePaths = {
  isPackaged: boolean;
  appRoot: string;
  snapshotRoot: string;
  clientDist: string;
  dataDir: string;
  dbPath: string;
  uploadRoot: string;
};

export function resolveRuntimePaths(serverDir: string): RuntimePaths {
  const isPackaged =
    typeof (process as NodeJS.Process & { pkg?: unknown }).pkg !== "undefined";
  const snapshotRoot = path.resolve(serverDir, "..", "..");
  const appRoot = isPackaged ? path.dirname(process.execPath) : snapshotRoot;

  const envDataDir = process.env.APP_DATA_DIR;
  const dataDir = envDataDir
    ? path.isAbsolute(envDataDir)
      ? envDataDir
      : path.resolve(appRoot, envDataDir)
    : isPackaged && process.platform === "win32"
      ? path.join(
          process.env.LOCALAPPDATA ||
            path.join(os.homedir(), "AppData", "Local"),
          "ERI DB Search",
          "data"
        )
      : path.join(appRoot, "data");
  ensureDir(dataDir);

  const dbPath = process.env.DATABASE_PATH
    ? path.isAbsolute(process.env.DATABASE_PATH)
      ? process.env.DATABASE_PATH
      : path.resolve(dataDir, process.env.DATABASE_PATH)
    : path.join(dataDir, "app.db");

  const uploadRoot = path.join(dataDir, "uploads");
  ensureDir(uploadRoot);

  let clientDist = process.env.CLIENT_DIST
    ? path.isAbsolute(process.env.CLIENT_DIST)
      ? process.env.CLIENT_DIST
      : path.resolve(appRoot, process.env.CLIENT_DIST)
    : path.join(appRoot, "client-dist");

  // Fallback for pkg snapshot assets when sidecar client-dist is absent.
  if (isPackaged && !fs.existsSync(path.join(clientDist, "index.html"))) {
    const snapshotDist = path.join(snapshotRoot, "client", "dist");
    if (fs.existsSync(path.join(snapshotDist, "index.html"))) {
      clientDist = snapshotDist;
    }
  }

  return {
    isPackaged,
    appRoot,
    snapshotRoot,
    clientDist,
    dataDir,
    dbPath,
    uploadRoot,
  };
}
