import path from "node:path";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.js";
import { apiRouter } from "./routes/api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const PORT = parseInt(process.env.PORT || "8787", 10);
const dbPath = process.env.DATABASE_PATH
  ? path.isAbsolute(process.env.DATABASE_PATH)
    ? process.env.DATABASE_PATH
    : path.resolve(repoRoot, process.env.DATABASE_PATH)
  : path.join(repoRoot, "data", "app.db");
const clientDist = process.env.CLIENT_DIST
  ? path.isAbsolute(process.env.CLIENT_DIST)
    ? process.env.CLIENT_DIST
    : path.resolve(repoRoot, process.env.CLIENT_DIST)
  : path.join(repoRoot, "client", "dist");

const db = openDatabase(dbPath);
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use("/api", apiRouter(db, { repoRoot }));

if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    const index = path.join(clientDist, "index.html");
    if (fs.existsSync(index)) res.sendFile(index);
    else next();
  });
}

app.listen(PORT, () => {
  console.log(`API http://localhost:${PORT}  (database: ${dbPath})`);
});
